# Binary Headers Code Generator

Schema-driven code generation for the binary headers wire protocol.

## Directory Structure

```
binary-headers/
├── schemas/              # Protocol definitions (like .proto files)
│   ├── index.ts          # Re-exports all schemas
│   ├── v0.ts             # v0 protocol schema
│   └── v1.ts             # v1 protocol schema (current)
├── codegen/              # Generator code
│   ├── generate.ts       # CLI entry point
│   ├── generator.ts      # Code generation logic
│   └── schema.ts         # Schema type definitions & DSL
├── generated/            # Generated output (.gitignore'd)
│   ├── constants.ts
│   ├── types.ts
│   ├── encoder.ts
│   └── decoder.ts
└── ...                   # Application code
```

## Quick Start

```bash
# Generate code using the default schema (v1)
npm run generate:binhdr --workspace=@redis/client

# Generate from a specific schema file
npx tsx lib/binary-headers/codegen/generate.ts lib/binary-headers/schemas/v1.ts
npx tsx lib/binary-headers/codegen/generate.ts lib/binary-headers/schemas/v0.ts

# Generate from a custom schema
npx tsx lib/binary-headers/codegen/generate.ts /path/to/my-schema.ts
```

## Generated Files

The generator produces four files in `binary-headers/generated/`:

| File | Description |
|------|-------------|
| `constants.ts` | Protocol constants (designator, sizes, limits) |
| `types.ts` | TypeScript interfaces for headers |
| `encoder.ts` | `createXxxHeader()` and `encodeXxxHeader()` functions |
| `decoder.ts` | `parseXxxHeader()` functions |

**Note:** Generated files are `.gitignore`'d and regenerated automatically via `prebuild` and `pretest` npm scripts.

## Protocol Versions

### v0 - Original Format (0x80)

10-byte request header, 8-byte response header.

```
Request (10 bytes):
┌──────────┬────────┬──────┬──────┬───────────┐
│ DESIG    │ LENGTH │ NCMD │ SLOT │ CLIENT_IDX│
│ 0x80     │ 4B BE  │ 1B   │ 2B BE│ 2B BE     │
└──────────┴────────┴──────┴──────┴───────────┘

Response (8 bytes):
┌──────────┬────────┬───────┬───────────┐
│ DESIG    │ LENGTH │ FLAGS │ CLIENT_IDX│
│ 0x80     │ 4B BE  │ 1B    │ 2B BE     │
└──────────┴────────┴───────┴───────────┘
```

### v1 - DMC Proxy Format (0xAE)

16-byte request and response headers with version field and request ID.

```
Request (16 bytes):
┌──────────┬─────────┬──────┬────────┬──────┬───────────┬──────────┐
│ MAGIC    │ VERSION │ SLOT │ LENGTH │ NCMD │ REQUEST_ID│ RESERVED │
│ 0xAE     │ 0x01    │ 2B BE│ 4B BE  │ 1B   │ 4B BE     │ 3B       │
└──────────┴─────────┴──────┴────────┴──────┴───────────┴──────────┘

Response (16 bytes):
┌──────────┬─────────┬──────────┬────────┬───────┬───────────┬──────────┐
│ MAGIC    │ VERSION │ RESERVED │ LENGTH │ FLAGS │ REQUEST_ID│ RESERVED │
│ 0xAE     │ 0x01    │ 2B       │ 4B BE  │ 1B    │ 4B BE     │ 3B       │
└──────────┴─────────┴──────────┴────────┴───────┴───────────┴──────────┘
```

## Defining a New Protocol Version

1. Create a new schema file `schemas/v2.ts`:

```typescript
import {
  protocol,
  message,
  constant,
  fixed,
  field,
  bitfield,
  padding,
} from '../codegen/schema';

export const BinaryHeadersProtocolV2 = protocol(
  'BinaryHeaders',
  2,  // version number
  [
    // Constants
    constant('DESIGNATOR', 0xAE, 'Magic byte'),
    constant('VERSION', 0x02, 'Protocol version'),
    constant('REQUEST_HEADER_SIZE', 20, 'Request header size'),
    // ... more constants
  ],
  [
    // Messages
    message('RequestHeader', 20, [
      fixed('designator', 'uint8', 0, 0xAE),
      fixed('version', 'uint8', 1, 0x02),
      field('slot', 'uint16', 2, { endian: 'big', min: 0, max: 0x3FFF }),
      // ... more fields
    ], 'Request header description'),

    message('ResponseHeader', 20, [
      // ... fields
    ], 'Response header description'),
  ],
  'Protocol description'
);
```

2. Generate:

```bash
npx tsx lib/binary-headers/codegen/generate.ts lib/binary-headers/schemas/v2.ts
```

3. Optionally, export it from `schemas/index.ts` for programmatic access:

```typescript
export { BinaryHeadersProtocolV0 } from './v0';
export { BinaryHeadersProtocolV1 } from './v1';
export { BinaryHeadersProtocolV2 } from './v2';

// Update default to latest
export { BinaryHeadersProtocolV2 as BinaryHeadersProtocol } from './v2';
```

4. Update the npm script in `package.json` if this becomes the default:

```json
{
  "scripts": {
    "generate:binhdr": "tsx lib/binary-headers/codegen/generate.ts lib/binary-headers/schemas/v2.ts"
  }
}
```

## Schema DSL Reference

### Field Types

| Type | Size | Description |
|------|------|-------------|
| `uint8` | 1 byte | Unsigned 8-bit integer |
| `uint16` | 2 bytes | Unsigned 16-bit integer |
| `uint32` | 4 bytes | Unsigned 32-bit integer |
| `int8` | 1 byte | Signed 8-bit integer |
| `int16` | 2 bytes | Signed 16-bit integer |
| `int32` | 4 bytes | Signed 32-bit integer |

### Field Kinds

#### `fixed(name, type, offset, value, options?)`
A field with a constant value (e.g., magic byte, version).

```typescript
fixed('designator', 'uint8', 0, 0xAE)
```

#### `field(name, type, offset, options?)`
A variable field with optional validation.

```typescript
field('slot', 'uint16', 2, { endian: 'big', min: 0, max: 0x3FFF })
```

Options:
- `endian`: `'big'` or `'little'` (default: `'big'`)
- `min`: Minimum value (generates validation)
- `max`: Maximum value (generates validation)

#### `bitfield(name, offset, fields)`
Multiple values packed into a single byte.

```typescript
bitfield('flags', 8, [
  { name: 'commandCount', bits: 7, mask: 0x7F },
  { name: 'protocolError', bits: 1, mask: 0x80 },
])
```

#### `padding(offset, size)`
Reserved bytes filled with zeros.

```typescript
padding(13, 3)  // 3 bytes of padding at offset 13
```

### Constants

```typescript
constant('MAX_PAYLOAD_LENGTH', 0xFFFFFFFF, 'Maximum payload size')
```

## Generated API

### Encoder

```typescript
// Create with validation
const result = createRequestHeader(slot, length, commandCount, requestId);
if (result.success) {
  const header = result.header;
}

// Encode to new buffer
const buffer = encodeRequestHeader(header);

// Encode into existing buffer at offset
const result = encodeRequestHeaderInto(header, buffer, offset);
```

### Decoder

```typescript
// Parse from buffer
const result = parseRequestHeader(buffer, offset);
if (result.success) {
  const { header, bytesConsumed } = result;
}

// Check designator
if (isBinaryHeaderDesignator(buffer[0])) {
  // Has binary header
}
```
