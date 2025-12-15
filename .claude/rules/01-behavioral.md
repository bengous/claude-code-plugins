---
# No paths: field = always loaded (unconditional)
---

# Before You Do Anything

**ALWAYS investigate before implementing.** When asked to create or modify plugins:

1. **Read reference implementations first**
   - `git-tools/` - Production plugin with commands, scripts, state management
   - `orchestration/` - Advanced plugin with agents, skills, hooks, complex workflows
   - Examine their structure, patterns, and conventions before writing new code

2. **Search for existing patterns**
   - Use Grep/Glob to find similar functionality in existing plugins
   - Reuse proven patterns rather than inventing new ones
   - Check if the feature already exists before creating it

3. **Understand the component landscape**
   - Commands, hooks, agents, and skills serve different purposes
   - Choose the right component type BEFORE implementing (see Component Selection rule)

**Never propose plugin changes without first reading the relevant existing code.**
