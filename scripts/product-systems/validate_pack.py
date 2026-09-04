#!/usr/bin/env python3
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

EXPECTED_SKILLS = {
    "routing-product-work",
    "grounding-product-context",
    "shaping-product-bets",
    "authoring-prds",
    "red-teaming-prds",
    "decomposing-product-work",
    "handing-off-product-work",
    "authoring-agent-skills",
    "evaluating-agent-skills",
}
REQUIRED_SECTIONS = {
    "## Overview",
    "## Inputs",
    "## Output contract",
    "## Workflow",
    "## Verification",
    "## Common failures",
}
NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
NETWORK_MODULES = {"requests", "http.client", "urllib.request", "httpx", "aiohttp"}
NETWORK_COMMANDS = {"curl", "wget"}


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, "missing opening frontmatter delimiter"
    end = text.find("\n---\n", 4)
    if end < 0:
        return {}, "missing closing frontmatter delimiter"
    raw = text[4:end]
    values: dict[str, str] = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        if ":" not in line:
            return {}, f"invalid frontmatter line: {line!r}"
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    return values, ""


def validate_relative_links(path: Path, text: str) -> list[str]:
    errors: list[str] = []
    for target in LINK_RE.findall(text):
        target = target.split("#", 1)[0]
        if not target or target.startswith(("http://", "https://", "mailto:", "/")):
            continue
        resolved = (path.parent / target).resolve()
        try:
            resolved.relative_to(path.parent.resolve())
        except ValueError:
            errors.append(f"{path}: relative link escapes skill directory: {target}")
            continue
        if not resolved.exists():
            errors.append(f"{path}: missing linked file: {target}")
    return errors


def validate_pack(root: Path) -> list[str]:
    root = root.resolve()
    errors: list[str] = []
    manifest_path = root / "docs" / "product-systems" / "MANIFEST.json"
    if not manifest_path.exists():
        return [f"missing {manifest_path}"]

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"invalid manifest: {exc}"]

    if manifest.get("schema_version") != "omp-product-systems.v1":
        errors.append("MANIFEST.json: unexpected schema_version")
    if manifest.get("promotion_status") != "candidate":
        errors.append("MANIFEST.json: v1 must ship as candidate")
    if set(manifest.get("skills", [])) != EXPECTED_SKILLS:
        errors.append("MANIFEST.json: skills do not match expected set")
    target = manifest.get("target", {})
    for forbidden_change in ("root_prompt_changes", "command_changes", "tool_changes"):
        if target.get(forbidden_change) is not False:
            errors.append(f"MANIFEST.json: {forbidden_change} must be false")

    skills_root = root / ".omp" / "skills"
    found = {p.parent.name for p in skills_root.glob("*/SKILL.md")}
    if found != EXPECTED_SKILLS:
        errors.append(f"skills found {sorted(found)}; expected {sorted(EXPECTED_SKILLS)}")

    for skill_name in sorted(EXPECTED_SKILLS):
        skill_path = skills_root / skill_name / "SKILL.md"
        if not skill_path.exists():
            errors.append(f"missing {skill_path}")
            continue
        text = skill_path.read_text(encoding="utf-8")
        fm, fm_error = parse_frontmatter(text)
        if fm_error:
            errors.append(f"{skill_path}: {fm_error}")
            continue
        if fm.get("name") != skill_name:
            errors.append(f"{skill_path}: name must match folder")
        if not NAME_RE.fullmatch(fm.get("name", "")):
            errors.append(f"{skill_path}: invalid lowercase-hyphenated name")
        description = fm.get("description", "")
        if not description.startswith("Use when"):
            errors.append(f"{skill_path}: description must start with 'Use when'")
        if len(description) > 500:
            errors.append(f"{skill_path}: description exceeds 500 characters")
        if len(text.splitlines()) > 500:
            errors.append(f"{skill_path}: exceeds 500 lines; move detail to references")
        for section in REQUIRED_SECTIONS:
            if section not in text:
                errors.append(f"{skill_path}: missing {section}")
        for marker in ("TODO", "TBD", "PLACEHOLDER"):
            if marker in text:
                errors.append(f"{skill_path}: unresolved marker {marker}")
        errors.extend(validate_relative_links(skill_path, text))

    eval_path = root / "tests" / "product-systems" / "evals" / "product-system.json"
    try:
        catalog = json.loads(eval_path.read_text(encoding="utf-8"))
        cases = catalog.get("cases", [])
        if catalog.get("schema_version") != "omp-skill-evals.v1":
            errors.append(f"{eval_path}: unexpected schema_version")
        if len(cases) < 20:
            errors.append(f"{eval_path}: expected at least 20 cases")
        kinds = {case.get("kind") for case in cases}
        if kinds != {"trigger", "behavior", "authority"}:
            errors.append(f"{eval_path}: missing eval kind coverage")
        covered = {case.get("expected_skill") for case in cases if case.get("expected_skill")}
        if covered != EXPECTED_SKILLS:
            errors.append(f"{eval_path}: skill coverage mismatch")
        ids = [case.get("id") for case in cases]
        if None in ids or len(ids) != len(set(ids)):
            errors.append(f"{eval_path}: case IDs must be unique and non-null")
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"invalid eval catalog: {exc}")

    for script in (root / "scripts" / "product-systems").glob("*.py"):
        script_text = script.read_text(encoding="utf-8")
        try:
            tree = ast.parse(script_text, filename=str(script))
        except SyntaxError as exc:
            errors.append(f"{script}: invalid Python: {exc}")
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name in NETWORK_MODULES or any(
                        alias.name.startswith(module + ".") for module in NETWORK_MODULES
                    ):
                        errors.append(f"{script}: network module import not allowed: {alias.name}")
            elif isinstance(node, ast.ImportFrom) and node.module:
                if node.module in NETWORK_MODULES or any(
                    node.module.startswith(module + ".") for module in NETWORK_MODULES
                ):
                    errors.append(f"{script}: network module import not allowed: {node.module}")
            elif isinstance(node, ast.Call):
                for arg in node.args:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        first = arg.value.strip().split(maxsplit=1)[0] if arg.value.strip() else ""
                        if first in NETWORK_COMMANDS:
                            errors.append(f"{script}: network command not allowed: {first}")

    required_docs = {
        "docs/product-systems/README.md",
        "docs/product-systems/INSTALL.md",
        "docs/product-systems/HANDOFF_TO_OMP.md",
        "docs/product-systems/CHATPRD_TEARDOWN.md",
        "docs/product-systems/ARCHITECTURE.md",
        "docs/product-systems/SOURCE_MAP.md",
        "docs/product-systems/ROLLOUT.md",
        "docs/product-systems/ADR-0002-product-systems-skill-layer.md",
    }
    for relative in required_docs:
        if not (root / relative).exists():
            errors.append(f"missing required document: {relative}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the OMP product systems skill pack.")
    parser.add_argument("root", nargs="?", default=str(Path(__file__).resolve().parents[2]))
    args = parser.parse_args()
    root = Path(args.root)
    errors = validate_pack(root)
    if errors:
        print("FAIL")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: manifest, skills, links, eval catalog, authority boundaries, and scripts are coherent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
