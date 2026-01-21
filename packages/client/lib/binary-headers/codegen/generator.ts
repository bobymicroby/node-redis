import type {
  ProtocolSchema,
  MessageSchema,
  Field,
  FixedField,
  VariableField,
  BitfieldGroup,
  Constant,
  PrimitiveType,
  Endianness,
} from './schema';

const TYPE_SIZES: Readonly<Record<PrimitiveType, number>> = {
  uint8: 1, int8: 1,
  uint16: 2, int16: 2,
  uint32: 4, int32: 4,
};

function typeSize(type: PrimitiveType): number {
  return TYPE_SIZES[type];
}

function endianSuffix(type: PrimitiveType, endian?: Endianness): string {
  return typeSize(type) > 1 ? (endian === 'little' ? 'LE' : 'BE') : '';
}

function bufferMethod(prefix: 'read' | 'write', type: PrimitiveType, endian?: Endianness): string {
  const suffix = endianSuffix(type, endian);
  const typeMap: Record<PrimitiveType, string> = {
    uint8: `${prefix}UInt8`, int8: `${prefix}Int8`,
    uint16: `${prefix}UInt16${suffix}`, int16: `${prefix}Int16${suffix}`,
    uint32: `${prefix}UInt32${suffix}`, int32: `${prefix}Int32${suffix}`,
  };
  return typeMap[type];
}

function indent(lines: ReadonlyArray<string>, level: number): string[] {
  const prefix = '  '.repeat(level);
  return lines.map(line => line ? prefix + line : '');
}

function formatHex(value: number): string {
  return value >= 16 ? '0x' + value.toString(16).toUpperCase() : value.toString();
}

function offsetExpr(offset: number, useOffset: boolean): string {
  return useOffset ? `offset + ${offset}` : `${offset}`;
}

// --- Constants Generation ---

function generateConstants(constants: ReadonlyArray<Constant>): string {
  const entries = constants.map(c => {
    const comment = c.description ? ` // ${c.description}` : '';
    return `  ${c.name}: ${formatHex(c.value)},${comment}`;
  });

  return [
    'export const BINHDR = {',
    ...entries,
    '} as const;',
    '',
    'export type BINHDR = typeof BINHDR;',
  ].join('\n');
}

// --- Interface Generation ---

interface FieldDef {
  readonly name: string;
  readonly type: string;
}

function extractFields(msg: MessageSchema, includeFixed: boolean): FieldDef[] {
  const fields: FieldDef[] = [];

  for (const f of msg.fields) {
    switch (f.kind) {
      case 'fixed':
        if (includeFixed) fields.push({ name: f.name, type: 'number' });
        break;
      case 'variable':
        fields.push({ name: f.name, type: 'number' });
        break;
      case 'bitfield':
        for (const bf of f.fields) {
          fields.push({ name: bf.name, type: bf.bits === 1 ? 'boolean' : 'number' });
        }
        break;
    }
  }

  return fields;
}

function generateInterface(msg: MessageSchema): string {
  const fields = extractFields(msg, true);
  const props = fields.map(f => `  readonly ${f.name}: ${f.type};`);
  return [`export interface ${msg.name} {`, ...props, '}'].join('\n');
}

// --- Validation ---

function collectValidationErrors(msg: MessageSchema): string[] {
  const errors: string[] = [];

  for (const f of msg.fields) {
    if (f.kind === 'variable' && f.validation) {
      errors.push(`invalid_${f.name}`);
    }
    if (f.kind === 'bitfield') {
      for (const bf of f.fields) {
        if (bf.bits > 1) errors.push(`invalid_${bf.name}`);
      }
    }
  }

  return errors.length > 0 ? errors : ['invalid_input'];
}

function generateValidationCode(msg: MessageSchema): string[] {
  const lines: string[] = [];

  for (const f of msg.fields) {
    if (f.kind === 'variable' && f.validation) {
      const { min, max } = f.validation;
      const checks = [`!Number.isInteger(${f.name})`];
      if (min !== undefined) checks.push(`${f.name} < ${formatHex(min)}`);
      if (max !== undefined) checks.push(`${f.name} > ${formatHex(max)}`);

      lines.push(`if (${checks.join(' || ')}) {`);
      lines.push(`  return { success: false, error: 'invalid_${f.name}' };`);
      lines.push('}');
      lines.push('');
    }

    if (f.kind === 'bitfield') {
      for (const bf of f.fields) {
        if (bf.bits > 1) {
          lines.push(`if (!Number.isInteger(${bf.name}) || ${bf.name} < 0 || ${bf.name} > ${formatHex(bf.mask)}) {`);
          lines.push(`  return { success: false, error: 'invalid_${bf.name}' };`);
          lines.push('}');
          lines.push('');
        }
      }
    }
  }

  return lines;
}

// --- Create Function ---

function generateCreateFunction(msg: MessageSchema): string {
  const inputFields = extractFields(msg, false);
  const errorType = `Create${msg.name}Error`;
  const errorTypes = collectValidationErrors(msg);
  const params = inputFields.map(f => `${f.name}: ${f.type}`).join(', ');

  const headerProps: string[] = [];
  for (const f of msg.fields) {
    switch (f.kind) {
      case 'fixed':
        headerProps.push(`    ${f.name}: ${formatHex(f.value)},`);
        break;
      case 'variable':
        headerProps.push(`    ${f.name},`);
        break;
      case 'bitfield':
        for (const bf of f.fields) {
          headerProps.push(`    ${bf.name},`);
        }
        break;
    }
  }

  return [
    `export type ${errorType} =`,
    `  | ${errorTypes.map(e => `'${e}'`).join('\n  | ')};`,
    '',
    `export type Create${msg.name}Result =`,
    `  | { readonly success: true; readonly header: ${msg.name} }`,
    `  | { readonly success: false; readonly error: ${errorType} };`,
    '',
    `export function create${msg.name}(${params}): Create${msg.name}Result {`,
    ...indent(generateValidationCode(msg), 1),
    '',
    `  const header: ${msg.name} = {`,
    ...headerProps,
    '  };',
    '',
    '  return { success: true, header };',
    '}',
  ].join('\n');
}

// --- Encoding (unified offset/non-offset) ---

function generateFieldEncode(f: Field, useOffset: boolean): string[] {
  switch (f.kind) {
    case 'fixed':
      return generateFixedEncode(f, useOffset);
    case 'variable':
      return generateVariableEncode(f, useOffset);
    case 'bitfield':
      return generateBitfieldEncode(f, useOffset);
    case 'padding':
      return generatePaddingEncode(f, useOffset);
  }
}

function generateFixedEncode(f: FixedField, useOffset: boolean): string[] {
  const pos = offsetExpr(f.offset, useOffset);
  if (f.type === 'uint8' || f.type === 'int8') {
    return [`buffer[${pos}] = ${formatHex(f.value)};`];
  }
  const method = bufferMethod('write', f.type, f.endian);
  return [`buffer.${method}(${formatHex(f.value)}, ${pos});`];
}

function generateVariableEncode(f: VariableField, useOffset: boolean): string[] {
  const pos = offsetExpr(f.offset, useOffset);
  if (f.type === 'uint8' || f.type === 'int8') {
    return [`buffer[${pos}] = header.${f.name};`];
  }
  const method = bufferMethod('write', f.type, f.endian);
  return [`buffer.${method}(header.${f.name}, ${pos});`];
}

function generateBitfieldEncode(f: BitfieldGroup, useOffset: boolean): string[] {
  const pos = offsetExpr(f.offset, useOffset);
  const parts = f.fields.map(bf =>
    bf.bits === 1
      ? `(header.${bf.name} ? ${formatHex(bf.mask)} : 0)`
      : `(header.${bf.name} & ${formatHex(bf.mask)})`
  );
  return [`buffer[${pos}] = ${parts.join(' | ')};`];
}

function generatePaddingEncode(f: { offset: number; size: number }, useOffset: boolean): string[] {
  const lines: string[] = [];
  for (let i = 0; i < f.size; i++) {
    const pos = offsetExpr(f.offset + i, useOffset);
    lines.push(`buffer[${pos}] = 0;`);
  }
  return lines;
}

function findSizeConstant(msg: MessageSchema, constants: ReadonlyArray<Constant>): string {
  const sizeName = msg.name.toUpperCase().replace(/HEADER$/, '_HEADER_SIZE');
  const found = constants.find(c => c.name === sizeName);
  return found ? `BINHDR.${found.name}` : msg.size.toString();
}

function generateEncoder(msg: MessageSchema, constants: ReadonlyArray<Constant>): string {
  const sizeConstant = findSizeConstant(msg, constants);
  const encodeLines = msg.fields.flatMap(f => generateFieldEncode(f, false));

  return [
    `export function encode${msg.name}(header: ${msg.name}): Buffer {`,
    `  const buffer = Buffer.allocUnsafe(${sizeConstant});`,
    '',
    ...indent(encodeLines, 1),
    '',
    '  return buffer;',
    '}',
  ].join('\n');
}

function generateEncoderInto(msg: MessageSchema, constants: ReadonlyArray<Constant>): string {
  const sizeConstant = findSizeConstant(msg, constants);
  const encodeLines = msg.fields.flatMap(f => generateFieldEncode(f, true));

  return [
    `export type Encode${msg.name}IntoResult =`,
    `  | { readonly success: true; readonly bytesWritten: number }`,
    `  | { readonly success: false; readonly error: 'buffer_too_small' };`,
    '',
    `export function encode${msg.name}Into(header: ${msg.name}, buffer: Buffer, offset: number): Encode${msg.name}IntoResult {`,
    `  if (buffer.length < offset + ${sizeConstant}) {`,
    `    return { success: false, error: 'buffer_too_small' };`,
    '  }',
    '',
    ...indent(encodeLines, 1),
    '',
    `  return { success: true, bytesWritten: ${sizeConstant} };`,
    '}',
  ].join('\n');
}

// --- Decoding ---

function generateVariableDecode(f: VariableField): string {
  if (f.type === 'uint8' || f.type === 'int8') {
    return `buffer[offset + ${f.offset}]`;
  }
  const method = bufferMethod('read', f.type, f.endian);
  return `buffer.${method}(offset + ${f.offset})`;
}

function generateDecoder(msg: MessageSchema, constants: ReadonlyArray<Constant>): string {
  const sizeConstant = findSizeConstant(msg, constants);

  // Fixed field validations
  const fixedValidations: string[] = [];
  for (const f of msg.fields.filter((f): f is FixedField => f.kind === 'fixed')) {
    if (f.name === 'designator') {
      fixedValidations.push(
        `  if (buffer[offset + ${f.offset}] !== ${formatHex(f.value)}) {`,
        `    return { success: false, error: 'invalid_designator' };`,
        '  }'
      );
    } else if (f.name === 'version') {
      fixedValidations.push(
        `  if (buffer[offset + ${f.offset}] !== ${formatHex(f.value)}) {`,
        `    return { success: false, error: 'invalid_version' };`,
        '  }'
      );
    }
  }

  // Header field assignments
  const headerFields: string[] = [];
  for (const f of msg.fields) {
    switch (f.kind) {
      case 'fixed':
        headerFields.push(`${f.name}: ${formatHex(f.value)}`);
        break;
      case 'variable':
        headerFields.push(`${f.name}: ${generateVariableDecode(f)}`);
        break;
      case 'bitfield':
        for (const bf of f.fields) {
          const expr = bf.bits === 1
            ? `(buffer[offset + ${f.offset}] & ${formatHex(bf.mask)}) !== 0`
            : `buffer[offset + ${f.offset}] & ${formatHex(bf.mask)}`;
          headerFields.push(`${bf.name}: ${expr}`);
        }
        break;
    }
  }

  return [
    `export type Parse${msg.name}Result =`,
    `  | { readonly success: true; readonly header: ${msg.name}; readonly bytesConsumed: number }`,
    `  | { readonly success: false; readonly error: Parse${msg.name}Error };`,
    '',
    `export type Parse${msg.name}Error = 'buffer_too_small' | 'invalid_designator' | 'invalid_version';`,
    '',
    `export function parse${msg.name}(buffer: Buffer, offset: number = 0): Parse${msg.name}Result {`,
    `  if (buffer.length < offset + ${sizeConstant}) {`,
    `    return { success: false, error: 'buffer_too_small' };`,
    '  }',
    '',
    ...fixedValidations,
    '',
    `  const header: ${msg.name} = {`,
    ...headerFields.map(f => `    ${f},`),
    '  };',
    '',
    '  return {',
    '    success: true,',
    '    header,',
    `    bytesConsumed: ${sizeConstant},`,
    '  };',
    '}',
  ].join('\n');
}

// --- Helpers ---

function generateHelpers(): string {
  return `export function isBinaryHeaderDesignator(byte: number): boolean {
  return byte === BINHDR.DESIGNATOR;
}

export function startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {
  return buffer.length > offset && isBinaryHeaderDesignator(buffer[offset]);
}

export function extractCommandCount(flagsByte: number): number {
  return flagsByte & BINHDR.COMMAND_COUNT_MASK;
}

export function hasProtocolError(flagsByte: number): boolean {
  return (flagsByte & BINHDR.PROTOCOL_ERROR_BIT) !== 0;
}`;
}

// --- Wire Format Documentation ---

function generateWireFormatDoc(msg: MessageSchema): string[] {
  const lines = [
    '/**',
    ` * ${msg.description || msg.name}`,
    ' * Wire format:',
  ];

  for (const f of msg.fields) {
    if (f.kind === 'padding') {
      lines.push(` * - Bytes ${f.offset}-${f.offset + f.size - 1}: Reserved`);
    } else if (f.kind === 'bitfield') {
      lines.push(` * - Byte ${f.offset}: Flags (${f.fields.map(bf => bf.name).join(', ')})`);
    } else {
      const size = typeSize(f.type);
      const range = size === 1 ? `Byte ${f.offset}` : `Bytes ${f.offset}-${f.offset + size - 1}`;
      lines.push(` * - ${range}: ${f.name}`);
    }
  }

  lines.push(' */');
  return lines;
}

// --- Main Entry Points ---

export interface GeneratorOutput {
  readonly constants: string;
  readonly types: string;
  readonly encoder: string;
  readonly decoder: string;
}

export function generateFromSchema(schema: ProtocolSchema): GeneratorOutput {
  const header = `// Generated from ${schema.name} protocol v${schema.version}`;

  // Types
  const descriptionComment = schema.description ? `// ${schema.description}` : '//';
  const typesLines = [
    header,
    descriptionComment,
    '',
  ];
  for (const msg of schema.messages) {
    typesLines.push(...generateWireFormatDoc(msg));
    typesLines.push(generateInterface(msg));
    typesLines.push('');
  }

  // Encoder
  const messageNames = schema.messages.map(m => m.name).join(', ');
  const encoderLines = [
    header,
    '',
    "import { BINHDR } from './constants';",
    `import type { ${messageNames} } from './types';`,
    '',
  ];
  for (const msg of schema.messages) {
    encoderLines.push(generateCreateFunction(msg));
    encoderLines.push('');
    encoderLines.push(generateEncoder(msg, schema.constants));
    encoderLines.push('');
    encoderLines.push(generateEncoderInto(msg, schema.constants));
    encoderLines.push('');
  }

  // Decoder
  const decoderLines = [
    header,
    '',
    "import { BINHDR } from './constants';",
    `import type { ${messageNames} } from './types';`,
    '',
  ];
  for (const msg of schema.messages) {
    decoderLines.push(generateDecoder(msg, schema.constants));
    decoderLines.push('');
  }
  decoderLines.push(generateHelpers());

  return {
    constants: generateConstants(schema.constants),
    types: typesLines.join('\n'),
    encoder: encoderLines.join('\n'),
    decoder: decoderLines.join('\n'),
  };
}
