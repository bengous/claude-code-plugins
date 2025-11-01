# Entity-Relationship Diagram Syntax Reference

Complete reference for Mermaid ER diagram syntax.

## Basic Syntax

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    PRODUCT ||--o{ LINE-ITEM : "ordered in"
```

## Entity Declaration

### Simple Entities

```mermaid
erDiagram
    CUSTOMER
    ORDER
    PRODUCT
```

### Entities with Attributes

```mermaid
erDiagram
    CUSTOMER {
        string name
        string email
        int age
    }
```

## Attribute Types

```mermaid
erDiagram
    USER {
        int id PK
        string username UK
        string email UK
        string password
        date created_at
        boolean is_active
        json metadata
    }
```

**Common types:**
- `int`, `integer`
- `string`, `varchar`
- `text`
- `date`, `datetime`, `timestamp`
- `boolean`, `bool`
- `float`, `double`, `decimal`
- `json`, `jsonb`
- `uuid`
- `blob`, `binary`

## Attribute Modifiers

```mermaid
erDiagram
    PRODUCT {
        int id PK "Primary Key"
        string sku UK "Unique Key"
        string name "Required field"
        decimal price FK "Foreign Key"
        int category_id
    }
```

**Key modifiers:**
- `PK` - Primary Key
- `FK` - Foreign Key
- `UK` - Unique Key

Add descriptions with quotes after the modifier.

## Relationships

### Relationship Syntax

Format: `Entity1 Relationship Cardinality Entity2 : "label"`

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE-ITEM : contains
    PRODUCT ||--o{ LINE-ITEM : "ordered in"
```

### Cardinality Markers

**Left side of relationship:**
- `||` - Exactly one
- `|o` - Zero or one
- `}|` - One or more
- `}o` - Zero or more

**Right side of relationship:**
- `||` - Exactly one
- `o|` - Zero or one
- `|{` - One or more
- `o{` - Zero or more

### Relationship Types

```mermaid
erDiagram
    %% One to One
    USER ||--|| PROFILE : has
    
    %% One to Many
    CUSTOMER ||--o{ ORDER : places
    
    %% Many to Many
    STUDENT }o--o{ COURSE : enrolls
    
    %% Zero or One to Many
    DEPARTMENT |o--o{ EMPLOYEE : manages
```

## Cardinality Examples

### One-to-One

```mermaid
erDiagram
    USER ||--|| PROFILE : "has one"
```

### One-to-Many

```mermaid
erDiagram
    AUTHOR ||--o{ BOOK : "writes"
    BLOG ||--o{ POST : "contains"
```

### Many-to-Many

```mermaid
erDiagram
    STUDENT }o--o{ COURSE : "enrolls in"
    ACTOR }o--o{ MOVIE : "appears in"
```

### Optional Relationships

```mermaid
erDiagram
    %% Employee may or may not have a manager
    EMPLOYEE }o--o| MANAGER : "reports to"
    
    %% Order may or may not have a discount
    ORDER ||--o| DISCOUNT : "applies"
```

## Complex Example

```mermaid
erDiagram
    CUSTOMER {
        int id PK
        string name
        string email UK
        string phone
        date created_at
    }
    
    ORDER {
        int id PK
        int customer_id FK
        date order_date
        string status
        decimal total
    }
    
    ORDER_ITEM {
        int id PK
        int order_id FK
        int product_id FK
        int quantity
        decimal price
    }
    
    PRODUCT {
        int id PK
        string name
        string sku UK
        decimal price
        int stock
        int category_id FK
    }
    
    CATEGORY {
        int id PK
        string name
        string description
    }
    
    ADDRESS {
        int id PK
        int customer_id FK
        string street
        string city
        string country
        string postal_code
        boolean is_default
    }
    
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER ||--o{ ADDRESS : "has"
    ORDER ||--|{ ORDER_ITEM : contains
    PRODUCT ||--o{ ORDER_ITEM : "ordered in"
    CATEGORY ||--o{ PRODUCT : categorizes
```

## Practical Patterns

### E-commerce Database

```mermaid
erDiagram
    USER {
        uuid id PK
        string email UK
        string password_hash
        string first_name
        string last_name
        datetime created_at
    }
    
    CART {
        uuid id PK
        uuid user_id FK
        datetime created_at
        datetime updated_at
    }
    
    CART_ITEM {
        uuid id PK
        uuid cart_id FK
        uuid product_id FK
        int quantity
    }
    
    PRODUCT {
        uuid id PK
        string name
        string description
        decimal price
        int stock_quantity
        uuid category_id FK
    }
    
    CATEGORY {
        uuid id PK
        string name
        string slug UK
        uuid parent_id FK
    }
    
    ORDER {
        uuid id PK
        uuid user_id FK
        string status
        decimal total_amount
        datetime created_at
    }
    
    ORDER_LINE {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        decimal unit_price
        decimal subtotal
    }
    
    PAYMENT {
        uuid id PK
        uuid order_id FK
        string payment_method
        string status
        decimal amount
        datetime processed_at
    }
    
    USER ||--o{ CART : has
    USER ||--o{ ORDER : places
    CART ||--|{ CART_ITEM : contains
    PRODUCT ||--o{ CART_ITEM : "added to"
    PRODUCT ||--o{ ORDER_LINE : "ordered in"
    CATEGORY ||--o{ PRODUCT : categorizes
    CATEGORY ||--o{ CATEGORY : "parent of"
    ORDER ||--|{ ORDER_LINE : contains
    ORDER ||--|| PAYMENT : "paid by"
```

### Blog System

```mermaid
erDiagram
    USER {
        int id PK
        string username UK
        string email UK
        string password_hash
        string role
    }
    
    POST {
        int id PK
        int author_id FK
        string title
        string slug UK
        text content
        string status
        datetime published_at
        datetime created_at
    }
    
    COMMENT {
        int id PK
        int post_id FK
        int user_id FK
        text content
        datetime created_at
    }
    
    TAG {
        int id PK
        string name UK
        string slug UK
    }
    
    POST_TAG {
        int post_id FK
        int tag_id FK
    }
    
    CATEGORY {
        int id PK
        string name UK
        string slug UK
    }
    
    USER ||--o{ POST : writes
    USER ||--o{ COMMENT : writes
    POST ||--o{ COMMENT : "has"
    POST }o--o{ TAG : "tagged with"
    POST }o--|| CATEGORY : "belongs to"
```

### Social Network

```mermaid
erDiagram
    USER {
        uuid id PK
        string username UK
        string email UK
        string bio
        string avatar_url
        datetime created_at
    }
    
    FOLLOW {
        uuid follower_id FK
        uuid following_id FK
        datetime created_at
    }
    
    POST {
        uuid id PK
        uuid user_id FK
        text content
        string media_url
        int likes_count
        datetime created_at
    }
    
    LIKE {
        uuid user_id FK
        uuid post_id FK
        datetime created_at
    }
    
    COMMENT {
        uuid id PK
        uuid post_id FK
        uuid user_id FK
        text content
        datetime created_at
    }
    
    MESSAGE {
        uuid id PK
        uuid sender_id FK
        uuid receiver_id FK
        text content
        boolean is_read
        datetime sent_at
    }
    
    USER ||--o{ POST : creates
    USER ||--o{ LIKE : "likes"
    USER ||--o{ COMMENT : writes
    USER ||--o{ MESSAGE : sends
    USER ||--o{ FOLLOW : follows
    USER ||--o{ FOLLOW : "followed by"
    POST ||--o{ LIKE : receives
    POST ||--o{ COMMENT : has
```

### SaaS Application

```mermaid
erDiagram
    ORGANIZATION {
        uuid id PK
        string name
        string subdomain UK
        string plan
        datetime created_at
    }
    
    USER {
        uuid id PK
        string email UK
        string password_hash
        string name
    }
    
    MEMBERSHIP {
        uuid id PK
        uuid user_id FK
        uuid org_id FK
        string role
        datetime joined_at
    }
    
    PROJECT {
        uuid id PK
        uuid org_id FK
        string name
        string description
        string status
    }
    
    TASK {
        uuid id PK
        uuid project_id FK
        uuid assigned_to FK
        string title
        text description
        string status
        string priority
        date due_date
    }
    
    SUBSCRIPTION {
        uuid id PK
        uuid org_id FK
        string plan
        string status
        decimal amount
        datetime starts_at
        datetime expires_at
    }
    
    ORGANIZATION ||--o{ MEMBERSHIP : has
    ORGANIZATION ||--o{ PROJECT : owns
    ORGANIZATION ||--|| SUBSCRIPTION : subscribes
    USER ||--o{ MEMBERSHIP : "member of"
    USER ||--o{ TASK : assigned
    PROJECT ||--o{ TASK : contains
```

## Best Practices

### 1. Use Consistent Naming

```mermaid
%% ✅ GOOD - Consistent naming
erDiagram
    USER {
        int id PK
        string first_name
        string last_name
    }
    
    USER_PROFILE {
        int id PK
        int user_id FK
    }

%% ❌ BAD - Inconsistent
erDiagram
    users {
        int ID
        string FirstName
    }
    
    UserProfiles {
        int profile_id
    }
```

### 2. Define Primary Keys

Always mark primary keys:

```mermaid
erDiagram
    ENTITY {
        int id PK
        string name
    }
```

### 3. Show Foreign Key Relationships

```mermaid
erDiagram
    PARENT {
        int id PK
    }
    
    CHILD {
        int id PK
        int parent_id FK
    }
    
    PARENT ||--o{ CHILD : has
```

### 4. Use Descriptive Relationship Labels

```mermaid
%% ✅ GOOD
erDiagram
    CUSTOMER ||--o{ ORDER : "places"
    ORDER ||--|{ LINE_ITEM : "contains"

%% ❌ BAD - No labels
erDiagram
    CUSTOMER ||--o{ ORDER : ""
    ORDER ||--|{ LINE_ITEM : ""
```

### 5. Group Related Entities

Keep related entities close together visually:

```mermaid
erDiagram
    %% User domain
    USER {
        int id PK
    }
    
    USER_PROFILE {
        int id PK
        int user_id FK
    }
    
    USER ||--|| USER_PROFILE : has
    
    %% Order domain
    ORDER {
        int id PK
    }
    
    ORDER_ITEM {
        int id PK
        int order_id FK
    }
    
    ORDER ||--|{ ORDER_ITEM : contains
```

### 6. Document Constraints

Use descriptions for important constraints:

```mermaid
erDiagram
    PRODUCT {
        int id PK "Auto-increment"
        string sku UK "Must be unique"
        decimal price "Must be > 0"
        int stock "Cannot be negative"
    }
```

## Common Pitfalls

### Wrong Cardinality Direction

```mermaid
%% ❌ WRONG - Arrows backward
erDiagram
    ORDER o{--|| CUSTOMER : places

%% ✅ CORRECT
erDiagram
    CUSTOMER ||--o{ ORDER : places
```

### Missing Relationship Labels

```mermaid
%% ❌ BAD - No labels
erDiagram
    A ||--o{ B : ""

%% ✅ GOOD - Clear labels
erDiagram
    A ||--o{ B : "relationship description"
```

### Inconsistent Entity Names

```mermaid
%% ❌ BAD - Mixed case and style
erDiagram
    users
    Orders
    Product_Items

%% ✅ GOOD - Consistent uppercase
erDiagram
    USER
    ORDER
    PRODUCT_ITEM
```

## Syntax Quick Reference

```mermaid
erDiagram
    %% Entity with attributes
    ENTITY_NAME {
        type attribute_name PK "Description"
        type attribute_name FK
        type attribute_name UK
    }
    
    %% Relationships
    A ||--|| B : "one to one"
    C ||--o{ D : "one to many"
    E }o--o{ F : "many to many"
    G |o--o| H : "zero or one to zero or one"
    
    %% Cardinality markers:
    %% || = exactly one
    %% |o = zero or one
    %% }| = one or more
    %% }o = zero or more
```

## Database Schema Documentation

ER diagrams are perfect for documenting database schemas. Include:

1. All entities (tables)
2. All attributes (columns) with types
3. Primary keys (PK)
4. Foreign keys (FK)
5. Unique constraints (UK)
6. Relationship cardinalities
7. Relationship descriptions

This makes it easy to understand the data model at a glance.
