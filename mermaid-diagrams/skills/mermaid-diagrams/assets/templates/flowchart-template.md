```mermaid
flowchart TB
    %% =================================================================
    %% FLOWCHART TEMPLATE
    %% Description: [Brief description of what this diagram shows]
    %% Last Updated: [Date]
    %% =================================================================
    
    %% -----------------------------------------------------------------
    %% SECTION 1: Entry Point
    %% -----------------------------------------------------------------
    Start[Start Process]
    
    %% -----------------------------------------------------------------
    %% SECTION 2: Main Processing Logic
    %% -----------------------------------------------------------------
    ProcessA[First Process Step]
    Decision1{Check Condition}
    ProcessB[Path A Processing]
    ProcessC[Path B Processing]
    
    %% -----------------------------------------------------------------
    %% SECTION 3: Error Handling
    %% -----------------------------------------------------------------
    ErrorHandler[Handle Error]
    LogError[Log Error Details]
    
    %% -----------------------------------------------------------------
    %% SECTION 4: Completion
    %% -----------------------------------------------------------------
    Complete[Complete Successfully]
    End[End Process]
    
    %% =================================================================
    %% CONNECTIONS
    %% =================================================================
    
    %% Main flow
    Start --> ProcessA
    ProcessA --> Decision1
    
    %% Decision branches
    Decision1 -->|Condition Met| ProcessB
    Decision1 -->|Condition Not Met| ProcessC
    
    %% Success path
    ProcessB --> Complete
    Complete --> End
    
    %% Error path
    ProcessC --> ErrorHandler
    ErrorHandler --> LogError
    LogError --> End
    
    %% =================================================================
    %% STYLING (Optional - remove if not needed)
    %% =================================================================
    
    classDef startEnd fill:#e1f5e1,stroke:#4caf50,stroke-width:2px
    classDef process fill:#e3f2fd,stroke:#2196f3,stroke-width:2px
    classDef decision fill:#fff3e0,stroke:#ff9800,stroke-width:2px
    classDef error fill:#ffebee,stroke:#f44336,stroke-width:2px
    
    class Start,End startEnd
    class ProcessA,ProcessB,Complete process
    class Decision1 decision
    class ProcessC,ErrorHandler,LogError error
```

**Usage Tips:**
1. Replace section descriptions with your actual use case
2. Keep related nodes grouped in sections
3. Use comments to explain complex logic
4. Define connections separately from node definitions
5. Apply styling last (optional)
