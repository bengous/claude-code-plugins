```mermaid
classDiagram
    %% =================================================================
    %% CLASS DIAGRAM TEMPLATE
    %% Description: [Brief description of the domain model]
    %% Last Updated: [Date]
    %% =================================================================
    
    %% -----------------------------------------------------------------
    %% SECTION 1: Core Domain Entities
    %% -----------------------------------------------------------------
    class User {
        +String id
        +String name
        +String email
        -String passwordHash
        +DateTime createdAt
        +Boolean isActive
        
        +register() void
        +login(credentials) Token
        +updateProfile(data) void
        +deactivate() void
    }
    
    class Order {
        +String id
        +User customer
        +List~OrderItem~ items
        +OrderStatus status
        +Money total
        +DateTime createdAt
        
        +addItem(Product, quantity) void
        +removeItem(itemId) void
        +calculateTotal() Money
        +submit() void
        +cancel() void
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 2: Value Objects / Supporting Classes
    %% -----------------------------------------------------------------
    class OrderItem {
        +String id
        +Product product
        +int quantity
        +Money unitPrice
        +Money subtotal
        
        +calculateSubtotal() Money
    }
    
    class Product {
        +String id
        +String name
        +String description
        +Money price
        +int stockQuantity
        
        +updateStock(quantity) void
        +isAvailable() Boolean
    }
    
    class Money {
        +Decimal amount
        +String currency
        
        +add(Money) Money
        +multiply(int) Money
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 3: Enumerations
    %% -----------------------------------------------------------------
    class OrderStatus {
        <<enumeration>>
        DRAFT
        SUBMITTED
        CONFIRMED
        SHIPPED
        DELIVERED
        CANCELLED
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 4: Interfaces / Abstract Classes
    %% -----------------------------------------------------------------
    class IRepository~T~ {
        <<interface>>
        +save(T entity)* void
        +findById(String id)* T
        +delete(String id)* void
    }
    
    class IOrderRepository {
        <<interface>>
        +findByUser(String userId)* List~Order~
        +findByStatus(OrderStatus)* List~Order~
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 5: Repository Implementations
    %% -----------------------------------------------------------------
    class OrderRepository {
        <<repository>>
        -Database database
        
        +save(Order) void
        +findById(String) Order
        +delete(String) void
        +findByUser(String) List~Order~
        +findByStatus(OrderStatus) List~Order~
    }
    
    %% =================================================================
    %% RELATIONSHIPS
    %% Group relationships by type for clarity
    %% =================================================================
    
    %% Inheritance / Realization
    IRepository <|-- IOrderRepository
    IOrderRepository <|.. OrderRepository
    
    %% Composition (strong ownership)
    Order *-- OrderItem : contains
    
    %% Aggregation (weak association)
    Order o-- User : placed by
    
    %% Association
    Order --> OrderStatus : has status
    OrderItem --> Product : references
    OrderItem --> Money : has price
    Order --> Money : has total
    
    %% Dependency
    OrderRepository ..> Order : manages
    
    %% Cardinality
    User "1" --> "*" Order : places
    Order "1" --> "1..*" OrderItem : contains
    Product "1" --> "0..*" OrderItem : ordered in
    
    %% =================================================================
    %% STYLING (Optional)
    %% =================================================================
    
    classDef entityClass fill:#e3f2fd,stroke:#1976d2,stroke-width:2px
    classDef valueObject fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef repository fill:#fff3e0,stroke:#f57c00,stroke-width:2px
    classDef interface fill:#e8f5e9,stroke:#388e3c,stroke-width:2px
    
    class User,Order,Product entityClass
    class OrderItem,Money valueObject
    class OrderRepository repository
    class IRepository,IOrderRepository interface
```

**Usage Tips:**
1. Group classes by layer/responsibility
2. Define all classes before relationships
3. Group relationships by type (inheritance, composition, etc.)
4. Use semantic class names (not technical IDs)
5. Include visibility modifiers (+, -, #, ~)
6. Add method return types for clarity
