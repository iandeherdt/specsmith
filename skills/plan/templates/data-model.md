# Data model: <Feature name>

**Plan**: [plan.md](plan.md)

## Entities

### <EntityName>

| Field | Type | Constraints | Notes |
| --- | --- | --- | --- |
| id | <type> | PK | |

Indexes:
- <name> on (`column1`, `column2`) — <purpose: query pattern this serves>

### <NextEntityName>

<one block per entity, in dependency order (parents before children)>

## Relationships

- <Entity> <verb> <Entity> (<cardinality>: one-to-one / one-to-many / many-to-many through `<join_table>`)

## State transitions

*Skip this section entirely if no entity in this feature has a state field.*

| Entity | From | Event | To | Side effects |
| --- | --- | --- | --- | --- |

## Migrations

Numbered, in apply order. Reference the migration file name once it exists (the `/tasks` execution may update this section with concrete file paths).

1. <Create table X with columns A, B, C>
2. <Add index Y on table X (column1, column2)>
3. <Backfill column D from view Z>
