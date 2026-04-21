# Binary Headers Code Generator

Schema-driven code generation for the binary headers wire protocol, following SBE (Simple Binary Encoding) principles.

## Directory Structure

```
binary-headers/
├── schemas/              # Protocol definitions
│   ├── v0.ts             # v0 protocol schema (0x80 format)
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
# Generate code using the default schema (v0)
npm run generate:binhdr --workspace=@redis/client

# Generate from a specific schema file
npx tsx lib/binary-headers/codegen/generate.ts lib/binary-headers/schemas/v0.ts
```

## Generated Files

| File | Description |
|------|-------------|
| `types.ts` | TypeScript interfaces for headers |
| `request-header-codec.ts` | `RequestHeaderEncoder` and `RequestHeaderDecoder` classes |
| `response-header-codec.ts` | `ResponseHeaderEncoder` and `ResponseHeaderDecoder` classes |

## Protocol Version

### v0 - Binary Headers Format (0x80)

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

## Defining a Schema

```typescript
import { protocol, message, fixed, field, bitfield } from '../codegen/schema';

export const BinaryHeadersProtocolV0 = protocol(
  'BinaryHeaders',
  0,
  [
    message('RequestHeader', 10, [
      fixed('designator', 'uint8', 0, 0x80),
      field('length', 'uint32', 1, { endian: 'big', min: 0, max: 0x7FFFFFFF }),
      field('commandCount', 'uint8', 5, { min: 1, max: 0x7F }),
      field('slot', 'uint16', 6, { endian: 'big', min: 0, max: 0x3FFF, nullValue: 0xFFFF }),
      field('clientIdx', 'uint16', 8, { endian: 'big', min: 0, max: 0xFFFF }),
    ], 'Request header description'),

    message('ResponseHeader', 8, [
      fixed('designator', 'uint8', 0, 0x80),
      field('length', 'uint32', 1, { endian: 'big', min: 0, max: 0x7FFFFFFF }),
      bitfield('flags', 5, [
        { name: 'commandCount', bits: 7, mask: 0x7F },
        { name: 'protocolError', bits: 1, mask: 0x80 },
      ]),
      field('clientIdx', 'uint16', 6, { endian: 'big', min: 0, max: 0xFFFF }),
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
fixed('designator', 'uint8', 0, 0x80)
```

#### `field(name, type, offset, options?)`

A variable field with optional constraints.

```typescript
field('slot', 'uint16', 6, { endian: 'big', min: 0, max: 0x3FFF, nullValue: 0xFFFF })
```

Options:
- `endian`: `'big'` or `'little'`
- `min`, `max`: Value constraints (exposed as static methods)
- `nullValue`: Sentinel value for "no value"
- `sinceVersion`: Schema version when field was added

#### `bitfield(name, offset, fields, sinceVersion?)`

Multiple values packed into a single byte.

```typescript
bitfield('flags', 5, [
  { name: 'commandCount', bits: 7, mask: 0x7F },
  { name: 'protocolError', bits: 1, mask: 0x80 },
])
```

## Generated API (SBE-style Flyweight)

### Encoder

```typescript
// Static one-shot encoding
const buffer = RequestHeaderEncoder.allocateAndEncode(length, commandCount, slot, clientIdx);

// Encode into existing buffer
RequestHeaderEncoder.encodeInto(buffer, offset, length, commandCount, slot, clientIdx);

// Flyweight instance (reusable, zero-allocation per encode)
const encoder = new RequestHeaderEncoder();
encoder.wrapAndWrite(buffer, 0)
  .length(100)
  .commandCount(5)
  .slot(1234)
  .clientIdx(42);

// Static metadata
RequestHeaderEncoder.ENCODED_LENGTH;        // 10
RequestHeaderEncoder.slotEncodingOffset();  // 6
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
  const length = decoder.length();
  const commandCount = decoder.commandCount();
  const slot = decoder.slot();
  const clientIdx = decoder.clientIdx();
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
