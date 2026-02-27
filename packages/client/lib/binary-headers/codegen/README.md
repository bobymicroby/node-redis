# Binary Headers Code Generator

Schema-driven code generation for the binary headers wire protocol, following SBE (Simple Binary Encoding) principles.

## Directory Structure

```
binary-headers/
├── schemas/              # Protocol definitions
│   ├── v0.ts             # v0 protocol schema (0x80 format)
│   └── v1.ts             # v1 protocol schema (0xAE format, current)
├── codegen/              # Generator code
│   ├── generate.ts       # CLI entry point
│   ├── flyweight-generator.ts  # SBE-style codec generation
│   └── schema.ts         # Schema type definitions & DSL
├── generated/            # Generated output (.gitignore'd)
│   ├── types.ts          # TypeScript interfaces
│   ├── request-header-codec.ts   # Flyweight encoder/decoder
│   └── response-header-codec.ts  # Flyweight encoder/decoder
└── ...
```

## Quick Start

```bash
# Generate code using the default schema (v1)
npm run generate:binhdr --workspace=@redis/client

# Generate from a specific schema file
npx tsx lib/binary-headers/codegen/generate.ts lib/binary-headers/schemas/v1.ts
```

## Generated Files

| File | Description |
|------|-------------|
| `types.ts` | TypeScript interfaces for headers |
| `request-header-codec.ts` | `RequestHeaderEncoder` and `RequestHeaderDecoder` classes |
| `response-header-codec.ts` | `ResponseHeaderEncoder` and `ResponseHeaderDecoder` classes |

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

## Defining a Schema

```typescript
import { protocol, message, fixed, field, bitfield } from '../codegen/schema';

export const BinaryHeadersProtocolV1 = protocol(
  'BinaryHeaders',
  1,
  [], // constants array (typically empty - derived from fields)
  [
    message('RequestHeader', 16, [
      fixed('designator', 'uint8', 0, 0xAE),
      fixed('version', 'uint8', 1, 0x01),
      field('slot', 'uint16', 2, { endian: 'big', min: 0, max: 0x3FFF, nullValue: 0xFFFF }),
      field('length', 'uint32', 4, { endian: 'big' }),
      field('commandCount', 'uint8', 8, { min: 1, max: 0x7F }),
      field('requestId', 'uint32', 9, { endian: 'big' }),
    ], 'Request header description'),

    message('ResponseHeader', 16, [
      fixed('designator', 'uint8', 0, 0xAE),
      fixed('version', 'uint8', 1, 0x01),
      field('length', 'uint32', 4, { endian: 'big' }),
      bitfield('flags', 8, [
        { name: 'commandCount', bits: 7, mask: 0x7F },
        { name: 'protocolError', bits: 1, mask: 0x80 },
      ]),
      field('requestId', 'uint32', 9, { endian: 'big' }),
    ], 'Response header description'),
  ],
  'Protocol description'
);
```

## Schema DSL Reference

### Field Types

| Type | Size |
|------|------|
| `uint8` | 1 byte |
| `uint16` | 2 bytes |
| `uint32` | 4 bytes |
| `int8` | 1 byte |
| `int16` | 2 bytes |
| `int32` | 4 bytes |

### Field Kinds

#### `fixed(name, type, offset, value, options?)`

A field with a constant value (e.g., magic byte, version).

```typescript
fixed('designator', 'uint8', 0, 0xAE)
fixed('version', 'uint8', 1, 0x01, { sinceVersion: 0 })
```

#### `field(name, type, offset, options?)`

A variable field with optional constraints.

```typescript
field('slot', 'uint16', 2, { endian: 'big', min: 0, max: 0x3FFF, nullValue: 0xFFFF })
```

Options:
- `endian`: `'big'` or `'little'`
- `min`, `max`: Value constraints (exposed as static methods)
- `nullValue`: Sentinel value for "no value"
- `sinceVersion`: Schema version when field was added

#### `bitfield(name, offset, fields, sinceVersion?)`

Multiple values packed into a single byte.

```typescript
bitfield('flags', 8, [
  { name: 'commandCount', bits: 7, mask: 0x7F },
  { name: 'protocolError', bits: 1, mask: 0x80 },
])
```

## Generated API (SBE-style Flyweight)

### Encoder

```typescript
// Static one-shot encoding
const buffer = RequestHeaderEncoder.allocateAndEncode(slot, length, commandCount, requestId);

// Encode into existing buffer
RequestHeaderEncoder.encodeInto(buffer, offset, slot, length, commandCount, requestId);

// Flyweight instance (reusable, zero-allocation per encode)
const encoder = new RequestHeaderEncoder();
encoder.wrapAndWrite(buffer, 0)
  .slot(1234)
  .length(100)
  .commandCount(5)
  .requestId(42);

// Static metadata
RequestHeaderEncoder.ENCODED_LENGTH;        // 16
RequestHeaderEncoder.slotEncodingOffset();  // 2
RequestHeaderEncoder.slotMaxValue();        // 0x3FFF
RequestHeaderEncoder.slotNullValue();       // 0xFFFF
```

#### Performance contract

Generated encoder write paths are intentionally unchecked for performance:
- No runtime range validation is performed in setter/encode paths.
- Callers are responsible for ensuring values satisfy generated metadata (`*MinValue()`, `*MaxValue()`, `*NullValue()`).
- If invalid values are passed, encoded bytes may be truncated or have unintended flag bits.

### Decoder

```typescript
// Flyweight instance (reusable)
const decoder = new RequestHeaderDecoder();
decoder.wrap(buffer, 0);

if (decoder.isValid()) {
  const slot = decoder.slot();
  const length = decoder.length();
  const commandCount = decoder.commandCount();
  const requestId = decoder.requestId();
}

// Static helpers
RequestHeaderDecoder.startsWithBinaryHeader(buffer);
RequestHeaderDecoder.peekDesignator(buffer);
```

### Utility Functions

```typescript
import { isRequestHeaderDesignator, isResponseHeaderDesignator } from './generated/...';

if (isRequestHeaderDesignator(buffer[0])) {
  // Has binary header
}
```
