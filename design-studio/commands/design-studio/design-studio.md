---
description: Generate 5 unique website designs
argument-hint: <url> [--port 5173]
model: opus
allowed-tools:
  - Task
  - Read
  - Write
  - Edit
  - Bash
  - AskUserQuestion
---

# Design Studio

Generate 5 unique redesigns for a website using Theo's pattern: one agent, sequential creation, natural differentiation.

**Input:** $ARGUMENTS (URL to redesign, optional --port)

---

## PHASE 1: SETUP

### Step 1.1: Parse Arguments

Extract from $ARGUMENTS:
- URL (required) - the site to redesign
- PORT (default: 5173) - dev server port

If no URL provided, ask user for it.

### Step 1.2: Scaffold Project

Run the scaffold script:

```bash
"${CLAUDE_PLUGIN_ROOT}/commands/design-studio/scaffold.ts" --port ${PORT} --serve
```

This creates the Vite + React Router project, writes all boilerplate files, creates the `.design-studio/` state directory, and starts the dev server.

Parse the JSON output to get:
- `project_path` - where the project was created
- `state_path` - where to store screenshots and analysis
- `dev_url` - the running dev server URL
- `pages` - list of created page files

---

## PHASE 2: ANALYZE

### Step 2.1: Capture Screenshot

Use the agent-browser skill to capture the original site:

```bash
agent-browser open "${URL}"
```

```bash
agent-browser wait --load networkidle
```

```bash
agent-browser screenshot --full ".design-studio/original.png"
```

```bash
agent-browser close
```

### Step 2.2: Analyze Site

Look at the screenshot (Read the image file) and the URL. Determine:

1. **Intent**: What does this site do? What problem does it solve?
2. **Audience**: Who is the target user? (developers, consumers, enterprise, etc.)
3. **Current Design**:
   - Colors (list 3-5 main colors)
   - Typography (heading font, body font if identifiable)
   - Layout (grid, cards, sidebar, etc.)
   - Mood (professional, playful, minimal, bold)
4. **Preserve**: What works well? What feels authentic?
5. **Improve**: What feels dated? What could be more distinctive?

### Step 2.3: Write Analysis

Write to `.design-studio/analysis.md`:

```markdown
# Site Analysis

**URL:** [the URL]
**Analyzed:** [current timestamp]

## Intent
[What the site does]

## Audience
[Who it's for]

## Current Design
- Colors: [list]
- Typography: [fonts]
- Layout: [description]
- Mood: [description]

## Preserve
1. [strength 1]
2. [strength 2]
3. [strength 3]

## Improve
1. [opportunity 1]
2. [opportunity 2]
3. [opportunity 3]
```

---

## PHASE 3: DESIGN

### Step 3.1: Build Injected Prompt

Read the analysis file content.

Build the complete prompt for the designer agent (substitute actual values):

```
You are redesigning a website.

## Site Analysis
[INSERT FULL CONTENT OF .design-studio/analysis.md HERE]

## Original Screenshot
The original site screenshot is at: .design-studio/original.png
Read it to see the current design.

## Project
- Path: ./design-studio
- Dev server: http://localhost:[PORT]
- Pages are at: ./design-studio/src/pages/1.tsx through 5.tsx

## Your Task
Create 5 unique redesigns at routes /1, /2, /3, /4, /5.

**Use your frontend-design skill to make these designs exceptional.**

Create them SEQUENTIALLY:
1. Create design 1, verify it renders, capture screenshot
2. Create design 2 - you've seen design 1, make it DIFFERENT
3. Create design 3 - you've seen 1 and 2, differentiate further
4. Create design 4 - you've seen 1, 2, 3, keep differentiating
5. Create design 5 - you've seen all 4, make it unique

This context awareness is your superpower. Natural differentiation.

## For Each Design
1. Edit ./design-studio/src/pages/N.tsx with your design
2. Verify it renders at http://localhost:[PORT]/N
3. Capture screenshot:
   agent-browser open "http://localhost:[PORT]/N"
   agent-browser wait --load networkidle
   agent-browser screenshot --full ".design-studio/design-N.png"
   agent-browser close

## Report Format
When done, return this exact format:

DESIGN_REPORT_START
## Design 1: [Name]
Aesthetic: [direction - e.g., brutalist, organic, editorial, etc.]
Key choices: [brief description]
Screenshot: .design-studio/design-1.png

## Design 2: [Name]
Aesthetic: [direction]
Key choices: [brief description]
Screenshot: .design-studio/design-2.png

## Design 3: [Name]
Aesthetic: [direction]
Key choices: [brief description]
Screenshot: .design-studio/design-3.png

## Design 4: [Name]
Aesthetic: [direction]
Key choices: [brief description]
Screenshot: .design-studio/design-4.png

## Design 5: [Name]
Aesthetic: [direction]
Key choices: [brief description]
Screenshot: .design-studio/design-5.png

## Issues
[Any problems encountered, or "None"]
DESIGN_REPORT_END
```

### Step 3.2: Spawn Designer

```
Task(
  description: "Create 5 unique designs",
  subagent_type: "general-purpose",
  model: "opus",
  prompt: [THE INJECTED PROMPT FROM STEP 3.1]
)
```

This is a BLOCKING call. Wait for designer to complete.

### Step 3.3: Parse Report

Designer returns a report between DESIGN_REPORT_START and DESIGN_REPORT_END.
Parse it to extract:
- 5 design names
- 5 aesthetic directions
- 5 key choices descriptions
- 5 screenshot paths
- Any issues

---

## PHASE 4: PRESENT & FINALIZE

### Step 4.1: Present Results

Output to user:

```
5 designs created!

View them at:
- http://localhost:[PORT]/1 - [Design 1 Name] ([Aesthetic])
- http://localhost:[PORT]/2 - [Design 2 Name] ([Aesthetic])
- http://localhost:[PORT]/3 - [Design 3 Name] ([Aesthetic])
- http://localhost:[PORT]/4 - [Design 4 Name] ([Aesthetic])
- http://localhost:[PORT]/5 - [Design 5 Name] ([Aesthetic])

Screenshots saved to .design-studio/
```

### Step 4.2: Get User Selection

Ask the user which design is their favorite:

```
AskUserQuestion(
  questions: [{
    question: "Which design is your favorite?",
    header: "Selection",
    options: [
      {label: "Design 1", description: "[Name] - [Aesthetic]"},
      {label: "Design 2", description: "[Name] - [Aesthetic]"},
      {label: "Design 3", description: "[Name] - [Aesthetic]"},
      {label: "Design 4", description: "[Name] - [Aesthetic]"},
      {label: "Design 5", description: "[Name] - [Aesthetic]"}
    ],
    multiSelect: false
  }]
)
```

### Step 4.3: Ask About Promotion

```
AskUserQuestion(
  questions: [{
    question: "Promote this design to the main route (/)?",
    header: "Promotion",
    options: [
      {label: "Yes", description: "Copy to index route"},
      {label: "No", description: "Keep at /N only"}
    ],
    multiSelect: false
  }]
)
```

### Step 4.4: Execute Promotion (if Yes)

If user chose Yes:
1. Read the chosen design file `./design-studio/src/pages/N.tsx`
2. Create `./design-studio/src/App.tsx` with the same content
3. Update `./design-studio/src/main.tsx` to add a default route:

```tsx
import App from './App'
// ... existing imports ...

// Add inside Routes:
<Route path="/" element={<App />} />
```

### Step 4.5: Summary

Output:

```
Done!

Final design: [Name]
Aesthetic: [Direction]
Location: http://localhost:[PORT]/ (or /N if not promoted)
Screenshots: .design-studio/

Next steps:
- Customize copy and images
- Deploy when ready
```
