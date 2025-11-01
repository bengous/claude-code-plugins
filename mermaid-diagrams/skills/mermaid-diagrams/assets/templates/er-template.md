```mermaid
erDiagram
    %% =================================================================
    %% ENTITY-RELATIONSHIP DIAGRAM TEMPLATE
    %% Description: [Brief description of the database schema]
    %% Database: [Database name/type]
    %% Last Updated: [Date]
    %% =================================================================
    
    %% -----------------------------------------------------------------
    %% SECTION 1: Core Entities
    %% Main business entities with their attributes
    %% -----------------------------------------------------------------
    
    USER {
        uuid id PK "Primary key"
        string email UK "Unique, not null"
        string username UK "Unique, not null"
        string password_hash "Hashed password"
        string first_name
        string last_name
        boolean is_active "Default: true"
        datetime created_at "Timestamp"
        datetime updated_at "Timestamp"
    }
    
    ORDER {
        uuid id PK
        uuid user_id FK "References USER.id"
        string order_number UK "Generated unique number"
        string status "enum: draft, submitted, confirmed, shipped, delivered, cancelled"
        decimal total_amount "Calculated total"
        datetime order_date
        datetime created_at
        datetime updated_at
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 2: Supporting Entities
    %% Supporting or junction tables
    %% -----------------------------------------------------------------
    
    ORDER_ITEM {
        uuid id PK
        uuid order_id FK "References ORDER.id"
        uuid product_id FK "References PRODUCT.id"
        int quantity "Must be > 0"
        decimal unit_price "Price at time of order"
        decimal subtotal "quantity * unit_price"
    }
    
    PRODUCT {
        uuid id PK
        string sku UK "Stock keeping unit"
        string name "Not null"
        text description
        decimal price "Current price"
        int stock_quantity "Available stock"
        uuid category_id FK "References CATEGORY.id"
        boolean is_active "Default: true"
        datetime created_at
        datetime updated_at
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 3: Reference/Lookup Entities
    %% Categories, tags, classifications
    %% -----------------------------------------------------------------
    
    CATEGORY {
        uuid id PK
        string name UK
        string slug UK "URL-friendly name"
        text description
        uuid parent_id FK "Self-reference for hierarchy"
    }
    
    %% -----------------------------------------------------------------
    %% SECTION 4: Additional Supporting Entities
    %% Addresses, payments, etc.
    %% -----------------------------------------------------------------
    
    ADDRESS {
        uuid id PK
        uuid user_id FK "References USER.id"
        string street
        string city
        string state
        string postal_code
        string country
        boolean is_default "Default shipping address"
        datetime created_at
    }
    
    PAYMENT {
        uuid id PK
        uuid order_id FK "References ORDER.id"
        string payment_method "enum: credit_card, paypal, etc"
        string transaction_id UK "External payment ID"
        string status "enum: pending, completed, failed, refunded"
        decimal amount
        datetime processed_at
    }
    
    %% =================================================================
    %% RELATIONSHIPS
    %% Group by entity for clarity
    %% =================================================================
    
    %% User relationships
    USER ||--o{ ORDER : "places"
    USER ||--o{ ADDRESS : "has"
    
    %% Order relationships
    ORDER ||--|{ ORDER_ITEM : "contains"
    ORDER ||--o| PAYMENT : "paid by"
    
    %% Product relationships  
    PRODUCT ||--o{ ORDER_ITEM : "ordered in"
    CATEGORY ||--o{ PRODUCT : "categorizes"
    CATEGORY ||--o{ CATEGORY : "parent of"
```

**Database Schema Documentation Notes:**

**Naming Conventions:**
- Tables: UPPERCASE (or lowercase, be consistent)
- Columns: snake_case
- Primary keys: `id`
- Foreign keys: `{table}_id`

**Common Patterns:**
- Timestamps: `created_at`, `updated_at`
- Soft deletes: `deleted_at` or `is_deleted`
- Primary keys: `uuid id PK` or `int id PK`
- Audit fields: `created_by`, `updated_by`

**Relationship Cardinality:**
- `||--||` : One to One (rare)
- `||--o{` : One to Many (most common)
- `}o--o{` : Many to Many (use junction table)
- `|o--o|` : Zero or One to Zero or One

**Usage Tips:**
1. Group related entities into sections
2. Document constraints in descriptions
3. Mark all primary and foreign keys
4. Include enum values in descriptions
5. Document calculated fields
6. Note any special indexes or constraints
