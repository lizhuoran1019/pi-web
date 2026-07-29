---
"@jmfederico/pi-web": patch
---

Re-ask a question without retyping it. Messages you sent now offer an "Edit from here" action in the chat, which puts that message's text back in the prompt editor, marks the message, and dims the replies below it to show what sending will replace. Nothing has changed in the session yet, so you can back out: Cancel on the hint above the editor — or Escape — restores whatever you had been typing, down to leaving the editor empty again. Sending is what forks the conversation at that message and continues on a new branch. The abandoned branch is retained in the session file and stays reachable from `/tree`, and no branch summary is generated. Attached images are not restored, the action is offered only while the session is idle and not archived, and it is not offered for messages that were expanded from a skill invocation.
