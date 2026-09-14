# GUI commands and tools

The same command menu is available in the browser workspace and packaged desktop
GUI. Type `/` at the start of an empty message, then search by name, description,
or connector. Arrow keys move the selection, Enter/Tab selects, and Escape closes
the menu while preserving the draft. On mobile, tap a row; ordinary Enter still
inserts a newline outside the menu.

- `/new`: new conversation.
- `/plan` and `/review`: prepare requests for planning or review. These are prompt
  shortcuts, not new policy modes or a guarantee that a model will comply.
- `/tools`: connector configuration.
- `/model`: model selection for new chats; existing chats retain their snapshot.
- `/context` and `/undo`: document/context panel, including existing Undo previews.
- `/approvals` and `/ledger`: actual VOID decision and audit views.
- `/export`: download the currently loaded conversation transcript as Markdown.
- `/stop`: request cancellation of a running conversation.

Tool rows come from `/api/tools`, using the conversation's saved tool snapshot
when a session exists. Before creation, configured tools are shown; local stdio
catalogues are discovered when the conversation starts. External tools retain
connector provenance and are classified at execution. Only built-in document
writes/deletes claim captured Undo. A tool selection prepares a request and opens
its parameter schema; it does not execute a tool or grant approval. Sending the
request goes through the normal model, VOID policy, approvals and ledger.

Public demo uses the same menu component with `/context`, `/workspace`, and only
its four isolated managed-document tools. Its catalogue never reads private
workspace state. Connected private accounts are not exposed in the demo.

Verified with a disposable provider fixture: menu selection, an actual managed
write and captured history, session catalogue, keyboard filtering and Escape,
light/dark appearance, and no horizontal overflow at 320 and 390 px. Native
Windows installation verification is recorded separately in WINDOWS-DESKTOP.md.
