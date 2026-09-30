Wait only when blocked with nothing else to do.
Returns on the first result of a job you own, a message sent to you, or a steering interrupt; a safety cap returns a still-running snapshot.
No owned job? Returns after a short message window that grows on repeated waits.
Results and messages auto-deliver. NEVER poll while work remains.
{{#if primePeers}}
Prime bridge peers: Prime messages do NOT auto-deliver; `wait` returns the next one (`[id] prime~<id>: …`) and acknowledges it once shown. `read agent://` lists local and Prime peers (`?status=parked` for parked Prime peers); reply with `write agent://prime~<id>` (optional `?replyTo=<message id>`), which returns the bridge receipt.
{{/if}}
