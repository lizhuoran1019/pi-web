---
"@jmfederico/pi-web": patch
---

Re-ask a question without retyping it. Messages you sent now offer an "Edit from here" action in the chat, which turns that message into an editor right where it sits, with the replies below it dimmed to show what re-asking will replace. Nothing has changed in the session yet, so backing out — Cancel or Escape — simply puts the message back. Re-ask is what forks the conversation at that message and sends your text as the new branch's opening prompt; Enter follows your usual send-versus-newline setting. The abandoned branch is retained in the session file and stays reachable from `/tree`, and no branch summary is generated. Attached images are not carried to the new branch, the action is offered only while the session is idle and not archived, and it is not offered for messages that were expanded from a skill invocation.
