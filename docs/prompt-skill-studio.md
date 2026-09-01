# Implemented local .crewcode loading for Prompt Builder Studio

 New supported folders:

 ```txt
   .crewcode/prompts/
   .crewcode/skills/
 ```

 Supported files:

- .md
- .markdown
- .txt
- .prompt
- .skill
- .json

 Markdown example:

 ```md
   ---
   title: Code review
   description: Review for bugs and maintainability
   category: review
   mode: Build
   agent: codex
   ---

   Review this code for correctness, edge cases, and maintainability.
 ```

 Skill example:

 ```md
   ---
   title: Terse answers
   description: Keep responses short and direct
   category: code
   mode: Build
   agent: codex
   enabled: false
   ---

   Always answer concisely. Avoid unnecessary explanation.
 ```

 JSON example:

 ```json
   {
     "title": "Debug failure",
     "description": "Find the likely root cause",
     "category": "debug",
     "mode": "Build",
     "agent": "codex",
     "body": "Debug this failure and propose the smallest fix."
   }
 ```

## Session-scoped prompt delivery

CrewCode sends execution-mode instructions and enabled skill bodies as session-start context, not as per-turn text. For restored chat sessions with existing history, CrewCode seeds the local delivery marker and skips re-sending the mode prompt so resumed threads do not waste tokens on duplicate Build/FULL/Plan/Ask instructions.

Skill activation is stored on the individual solo chat session. Enabling or removing a skill in one chat does not change the active skills in another chat; duplicated sessions copy the source session's active skill selection.

## Studio list scrolling

On desktop and tablet widths above 768px, the Prompt/Skills rail keeps its
header, filters, and footer fixed while the card list fills the remaining
height and scrolls independently. The `.pb-left` → `.pb-inner` → `.pb-list`
flex chain must retain `min-height: 0`; otherwise the list expands to its
content and its vertical overflow never activates.

The phone layout remains a separate `max-width: 768px` contract: it stays
edge-to-edge, preserves its compact toolbar and wrapping cards, and continues
to use the list as its bounded scrolling region.
