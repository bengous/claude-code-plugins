```mermaid
sequenceDiagram
    %% =================================================================
    %% SEQUENCE DIAGRAM TEMPLATE
    %% Description: [Brief description of the interaction flow]
    %% Last Updated: [Date]
    %% =================================================================
    
    %% -----------------------------------------------------------------
    %% PARTICIPANTS
    %% Define all participants upfront for clear ordering
    %% -----------------------------------------------------------------
    actor User
    participant Client
    participant Server
    participant Database
    participant ExternalAPI
    
    %% -----------------------------------------------------------------
    %% SECTION 1: Initialization / Authentication
    %% -----------------------------------------------------------------
    User->>Client: Initiate action
    Client->>Server: Request with credentials
    activate Server
    
    Server->>Database: Validate user
    activate Database
    Database-->>Server: User data
    deactivate Database
    
    alt Authenticated
        Note over Server: User is valid
        Server-->>Client: Authentication success
    else Not Authenticated
        Note over Server: Invalid credentials
        Server-->>Client: 401 Unauthorized
        deactivate Server
        Client-->>User: Show error
    end
    
    %% -----------------------------------------------------------------
    %% SECTION 2: Main Business Logic
    %% -----------------------------------------------------------------
    Client->>Server: Process request
    activate Server
    
    Server->>Database: Query data
    activate Database
    Database-->>Server: Data result
    deactivate Database
    
    %% Optional external call
    opt Call external service if needed
        Server->>ExternalAPI: External request
        activate ExternalAPI
        ExternalAPI-->>Server: External response
        deactivate ExternalAPI
    end
    
    %% -----------------------------------------------------------------
    %% SECTION 3: Response / Completion
    %% -----------------------------------------------------------------
    Server->>Server: Process data
    Server-->>Client: Success response
    deactivate Server
    
    Client-->>User: Display result
    
    %% -----------------------------------------------------------------
    %% SECTION 4: Error Handling (Alternative flow)
    %% -----------------------------------------------------------------
    Note over Client,Database: Error handling flow
    
    alt Server error
        Server-->>Client: 500 Internal Server Error
        Client-->>User: Show error message
    else Network error
        Client-->>User: Connection failed
    end
    
    %% =================================================================
    %% BACKGROUND HIGHLIGHTING (Optional)
    %% =================================================================
    rect rgb(230, 247, 255)
    note right of Server: Phase 1: Authentication
    end
    
    rect rgb(230, 255, 230)
    note right of Server: Phase 2: Data Processing
    end
```

**Usage Tips:**
1. Always declare participants explicitly at the top
2. Group related interactions into commented sections
3. Use activate/deactivate to show processing time
4. Include error paths with alt/else blocks
5. Add notes to explain complex logic
6. Use autonumber if sequence matters (add at top)
