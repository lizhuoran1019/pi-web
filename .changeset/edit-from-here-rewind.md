---
"@jmfederico/pi-web": patch
---

Re-ask a question without retyping it. Messages you sent now offer an "Edit from here" action in the chat, which rewinds the session to just before that message and puts its text back in the prompt editor to edit and send again; sending then continues on a new branch. The abandoned branch is retained in the session file and stays reachable from `/tree`, and no branch summary is generated. Attached images are not restored, the action is disabled while the session is busy or archived, and it is not offered for messages that were expanded from a skill invocation.
