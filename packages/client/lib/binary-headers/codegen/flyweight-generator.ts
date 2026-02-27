import type {
  ProtocolSchema,
  MessageSchema,
  Field,
  FixedField,
  VariableField,
  BitfieldGroup,
  PrimitiveType,
  Endianness,
  Bitfield,
} from './schema';


const TYPE_SIZES: Readonly<Record<PrimitiveType, number>> = {
  uint8: 1, int8: 1,
  uint16: 2, int16: 2,
  uint32: 4, int32: 4,
};

const TYPE_MAX_VALUES: Readonly<Record<PrimitiveType, number>> = {
  uint8: 0xFF,
  int8: 0x7F,
  uint16: 0xFFFF,
  int16: 0x7FFF,
  uint32: 0xFFFFFFFF,
  int32: 0x7FFFFFFF,
};

const TYPE_MIN_VALUES: Readonly<Record<PrimitiveType, number>> = {
  uint8: 0,
  int8: -128,
  uint16: 0,
  int16: -32768,
  uint32: 0,
  int32: -2147483648,
};

function typeSize(type: PrimitiveType): number {
  return TYPE_SIZES[type];
}

function typeMaxValue(type: PrimitiveType): number {
  return TYPE_MAX_VALUES[type];
}

function typeMinValue(type: PrimitiveType): number {
  return TYPE_MIN_VALUES[type];
}

function endianSuffix(type: PrimitiveType, endian?: Endianness): string {
  return typeSize(type) > 1 ? (endian === 'little' ? 'LE' : 'BE') : '';
}

function bufferReadMethod(type: PrimitiveType, endian?: Endianness): string {
  const suffix = endianSuffix(type, endian);
  const methodMap: Record<PrimitiveType, string> = {
    uint8: 'readUInt8', int8: 'readInt8',
    uint16: `readUInt16${suffix}`, int16: `readInt16${suffix}`,
    uint32: `readUInt32${suffix}`, int32: `readInt32${suffix}`,
  };
  return methodMap[type];
}

function formatHex(value: number): string {
  return value >= 16 ? '0x' + value.toString(16).toUpperCase() : value.toString();
}

/**
 * Generate fast manual byte write statements for multi-byte integers.
 * This is faster than Buffer.writeUInt32BE/writeUInt16BE because it avoids
 * the overhead of bounds checking and method dispatch.
 */
function generateFastByteWrites(
  bufferExpr: string,
  offsetExpr: string,
  valueExpr: string,
  type: PrimitiveType,
  endian?: Endianness
): string[] {
  const isBigEndian = endian !== 'little';
  const lines: string[] = [];

  if (type === 'uint32' || type === 'int32') {
    if (isBigEndian) {
      lines.push(`${bufferExpr}[${offsetExpr}] = (${valueExpr} >>> 24) & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 1] = (${valueExpr} >>> 16) & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 2] = (${valueExpr} >>> 8) & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 3] = ${valueExpr} & 0xFF;`);
    } else {
      lines.push(`${bufferExpr}[${offsetExpr}] = ${valueExpr} & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 1] = (${valueExpr} >>> 8) & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 2] = (${valueExpr} >>> 16) & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 3] = (${valueExpr} >>> 24) & 0xFF;`);
    }
  } else if (type === 'uint16' || type === 'int16') {
    if (isBigEndian) {
      lines.push(`${bufferExpr}[${offsetExpr}] = (${valueExpr} >>> 8) & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 1] = ${valueExpr} & 0xFF;`);
    } else {
      lines.push(`${bufferExpr}[${offsetExpr}] = ${valueExpr} & 0xFF;`);
      lines.push(`${bufferExpr}[${offsetExpr} + 1] = (${valueExpr} >>> 8) & 0xFF;`);
    }
  } else {
    // uint8/int8 - single byte
    lines.push(`${bufferExpr}[${offsetExpr}] = ${valueExpr};`);
  }

  return lines;
}


interface FieldDef {
  readonly name: string;
  readonly type: string;
}

function extractInterfaceFields(msg: MessageSchema): ReadonlyArray<FieldDef> {
  const fields: FieldDef[] = [];

  for (const f of msg.fields) {
    if (f.kind === 'fixed' || f.kind === 'variable') {
      fields.push({
        name: f.name,
        type: 'number',
      });
    } else if (f.kind === 'bitfield') {
      for (const bf of f.fields) {
        fields.push({
          name: bf.name,
          type: bf.bits === 1 ? 'boolean' : 'number',
        });
      }
    }
  }

  return fields;
}

function generateInterface(msg: MessageSchema): string {
  const fields = extractInterfaceFields(msg);
  const props = fields.map(f => `  readonly ${f.name}: ${f.type};`).join('\n');
  return `export interface ${msg.name} {\n${props}\n}`;
}

function generateToObjectMethod(msg: MessageSchema, className: string): string[] {
  const fields = extractInterfaceFields(msg);
  const lines: string[] = [];

  lines.push(`  toObject(): ${msg.name} {`);
  lines.push('    return {');

  for (const f of fields) {
    lines.push(`      ${f.name}: this.${f.name}(),`);
  }

  lines.push('    };');
  lines.push('  }');

  return lines;
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

interface FieldMetadata {
  readonly name: string;
  readonly offset: number;
  readonly length: number;
  readonly sinceVersion: number;
  readonly isBoolean: boolean;
  readonly isFixed: boolean;
  readonly type: PrimitiveType | 'bitfield-bool' | 'bitfield-num';
  readonly endian?: Endianness;
  readonly fixedValue?: number;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly nullValue?: number;
  readonly mask?: number;
}

function extractFieldMetadata(field: Field): ReadonlyArray<FieldMetadata> {
  switch (field.kind) {
    case 'fixed':
      return [extractFixedMetadata(field)];
    case 'variable':
      return [extractVariableMetadata(field)];
    case 'bitfield':
      return field.fields.map(bf => extractBitfieldMetadata(bf, field.offset, field.sinceVersion));
  }
}

function extractFixedMetadata(field: FixedField): FieldMetadata {
  return {
    name: field.name,
    offset: field.offset,
    length: typeSize(field.type),
    sinceVersion: field.sinceVersion ?? 0,
    isBoolean: false,
    isFixed: true,
    type: field.type,
    endian: field.endian,
    fixedValue: field.value,
  };
}

function extractVariableMetadata(field: VariableField): FieldMetadata {
  return {
    name: field.name,
    offset: field.offset,
    length: typeSize(field.type),
    minValue: field.validation?.min ?? typeMinValue(field.type),
    maxValue: field.validation?.max ?? typeMaxValue(field.type),
    nullValue: field.nullValue,
    sinceVersion: field.sinceVersion ?? 0,
    isBoolean: false,
    isFixed: false,
    type: field.type,
    endian: field.endian,
  };
}

function extractBitfieldMetadata(bf: Bitfield, offset: number, groupSinceVersion?: number): FieldMetadata {
  return {
    name: bf.name,
    offset,
    length: 1,
    sinceVersion: bf.sinceVersion ?? groupSinceVersion ?? 0,
    isBoolean: bf.bits === 1,
    isFixed: false,
    type: bf.bits === 1 ? 'bitfield-bool' : 'bitfield-num',
    mask: bf.mask,
    maxValue: bf.bits === 1 ? undefined : bf.mask,
    minValue: bf.bits === 1 ? undefined : 0,
  };
}

function generateStaticMetadataMethods(meta: FieldMetadata): string[] {
  const lines: string[] = [];
  const name = meta.name;

  lines.push(`  static ${name}EncodingOffset(): number {`);
  lines.push(`    return ${meta.offset};`);
  lines.push('  }');
  lines.push('');

  lines.push(`  static ${name}EncodingLength(): number {`);
  lines.push(`    return ${meta.length};`);
  lines.push('  }');
  lines.push('');

  lines.push(`  static ${name}SinceVersion(): number {`);
  lines.push(`    return ${meta.sinceVersion};`);
  lines.push('  }');
  lines.push('');

  if (meta.isFixed && meta.fixedValue !== undefined) {
    lines.push(`  static ${name}ConstantValue(): number {`);
    lines.push(`    return ${formatHex(meta.fixedValue)};`);
    lines.push('  }');
    lines.push('');
  }

  if (meta.minValue !== undefined && !meta.isBoolean && !meta.isFixed) {
    lines.push(`  static ${name}MinValue(): number {`);
    lines.push(`    return ${formatHex(meta.minValue)};`);
    lines.push('  }');
    lines.push('');
  }

  if (meta.maxValue !== undefined && !meta.isBoolean && !meta.isFixed) {
    lines.push(`  static ${name}MaxValue(): number {`);
    lines.push(`    return ${formatHex(meta.maxValue)};`);
    lines.push('  }');
    lines.push('');
  }

  if (meta.nullValue !== undefined) {
    lines.push(`  static ${name}NullValue(): number {`);
    lines.push(`    return ${formatHex(meta.nullValue)};`);
    lines.push('  }');
    lines.push('');
  }

  return lines;
}

function generateEncoderSetter(meta: FieldMetadata, className: string): string[] {
  const lines: string[] = [];
  const name = meta.name;

  if (meta.type === 'bitfield-bool') {
    lines.push(`  ${name}(value: boolean): ${className} {`);
    lines.push(`    const byteOffset = this.#offset + ${className}.${name}EncodingOffset();`);
    lines.push(`    const current = this.#buffer![byteOffset];`);
    lines.push(`    this.#buffer![byteOffset] = value`);
    lines.push(`      ? (current | ${formatHex(meta.mask!)})`);
    lines.push(`      : (current & ${formatHex(~meta.mask! & 0xFF)});`);
    lines.push('    return this;');
    lines.push('  }');
  } else if (meta.type === 'bitfield-num') {
    lines.push(`  ${name}(value: number): ${className} {`);
    lines.push(`    const byteOffset = this.#offset + ${className}.${name}EncodingOffset();`);
    lines.push(`    const current = this.#buffer![byteOffset] & ${formatHex(~meta.mask! & 0xFF)};`);
    lines.push(`    this.#buffer![byteOffset] = current | (value & ${formatHex(meta.mask!)});`);
    lines.push('    return this;');
    lines.push('  }');
  } else {
    // Use fast manual byte writes for all numeric types
    lines.push(`  ${name}(value: number): ${className} {`);
    const offsetExpr = `this.#offset + ${className}.${name}EncodingOffset()`;
    const byteWrites = generateFastByteWrites('this.#buffer!', offsetExpr, 'value', meta.type, meta.endian);
    for (const line of byteWrites) {
      lines.push(`    ${line}`);
    }
    lines.push('    return this;');
    lines.push('  }');
  }

  lines.push('');
  return lines;
}

function generateEncoderClass(msg: MessageSchema, schemaVersion: number): string {
  const className = `${msg.name}Encoder`;
  const allMetadata = msg.fields.flatMap(extractFieldMetadata);
  const fixedFields = allMetadata.filter(m => m.isFixed);
  const variableFields = allMetadata.filter(m => !m.isFixed);

  const lines: string[] = [];

  lines.push(generateInterface(msg));
  lines.push('');

  lines.push(`export class ${className} {`);

  lines.push(`  static readonly ENCODED_LENGTH = ${msg.size};`);
  lines.push(`  static readonly SCHEMA_VERSION = ${schemaVersion};`);
  lines.push('');

  for (const meta of allMetadata) {
    lines.push(...generateStaticMetadataMethods(meta));
  }

  lines.push('  #buffer: Buffer | null = null;');
  lines.push('  #offset = 0;');
  lines.push('');

  lines.push(`  wrap(buffer: Buffer, offset: number): ${className} {`);
  lines.push('    this.#buffer = buffer;');
  lines.push('    this.#offset = offset;');
  lines.push('    return this;');
  lines.push('  }');
  lines.push('');

  lines.push(`  wrapAndWrite(buffer: Buffer, offset: number): ${className} {`);
  lines.push('    this.wrap(buffer, offset);');
  for (const meta of fixedFields) {
    lines.push(`    this.${meta.name}(${className}.${meta.name}ConstantValue());`);
  }
  lines.push('    return this;');
  lines.push('  }');
  lines.push('');

  lines.push('  buffer(): Buffer | null {');
  lines.push('    return this.#buffer;');
  lines.push('  }');
  lines.push('');

  lines.push('  offset(): number {');
  lines.push('    return this.#offset;');
  lines.push('  }');
  lines.push('');

  lines.push('  encodedLength(): number {');
  lines.push(`    return ${className}.ENCODED_LENGTH;`);
  lines.push('  }');
  lines.push('');

  for (const meta of allMetadata) {
    lines.push(...generateEncoderSetter(meta, className));
  }

  const paramFields = variableFields.filter(m => !m.isBoolean || m.type === 'bitfield-bool');
  const params = paramFields.map(m => {
    const type = m.isBoolean ? 'boolean' : 'number';
    return `${m.name}: ${type}`;
  }).join(', ');

  lines.push(`  static encodeInto(buffer: Buffer, offset: number, ${params}): number {`);

  for (const meta of fixedFields) {
    const offsetExpr = `offset + ${className}.${meta.name}EncodingOffset()`;
    const valueExpr = `${className}.${meta.name}ConstantValue()`;
    const byteWrites = generateFastByteWrites('buffer', offsetExpr, valueExpr, meta.type as PrimitiveType, meta.endian);
    for (const line of byteWrites) {
      lines.push(`    ${line}`);
    }
  }

  const bitfieldGroups = new Map<number, FieldMetadata[]>();
  for (const meta of variableFields) {
    if (meta.type === 'bitfield-bool' || meta.type === 'bitfield-num') {
      const group = bitfieldGroups.get(meta.offset) ?? [];
      group.push(meta);
      bitfieldGroups.set(meta.offset, group);
    } else {
      const offsetExpr = `offset + ${className}.${meta.name}EncodingOffset()`;
      const byteWrites = generateFastByteWrites('buffer', offsetExpr, meta.name, meta.type, meta.endian);
      for (const line of byteWrites) {
        lines.push(`    ${line}`);
      }
    }
  }

  for (const [, members] of bitfieldGroups) {
    const firstMember = members[0];
    const parts = members.map(m => {
      if (m.isBoolean) {
        return `(${m.name} ? ${formatHex(m.mask!)} : 0)`;
      }
      return `(${m.name} & ${formatHex(m.mask!)})`;
    });
    lines.push(`    buffer[offset + ${className}.${firstMember.name}EncodingOffset()] = ${parts.join(' | ')};`);
  }

  lines.push(`    return ${className}.ENCODED_LENGTH;`);
  lines.push('  }');
  lines.push('');

  lines.push(`  static allocateAndEncode(${params}): Buffer {`);
  lines.push(`    const buffer = Buffer.allocUnsafe(${className}.ENCODED_LENGTH);`);
  const argList = paramFields.map(f => f.name).join(', ');
  lines.push(`    ${className}.encodeInto(buffer, 0, ${argList});`);
  lines.push('    return buffer;');
  lines.push('  }');

  lines.push('}');

  return lines.join('\n');
}

function generateDecoderGetter(meta: FieldMetadata, className: string): string[] {
  const lines: string[] = [];
  const name = meta.name;

  if (meta.isFixed) {
    lines.push(`  ${name}(): number {`);
    lines.push(`    return ${className}.${name}ConstantValue();`);
    lines.push('  }');
  } else if (meta.type === 'bitfield-bool') {
    lines.push(`  ${name}(): boolean {`);
    lines.push(`    return (this.#buffer![this.#offset + ${className}.${name}EncodingOffset()] & ${formatHex(meta.mask!)}) !== 0;`);
    lines.push('  }');
  } else if (meta.type === 'bitfield-num') {
    lines.push(`  ${name}(): number {`);
    lines.push(`    return this.#buffer![this.#offset + ${className}.${name}EncodingOffset()] & ${formatHex(meta.mask!)};`);
    lines.push('  }');
  } else if (meta.type === 'uint8' || meta.type === 'int8') {
    lines.push(`  ${name}(): number {`);
    lines.push(`    return this.#buffer![this.#offset + ${className}.${name}EncodingOffset()];`);
    lines.push('  }');
  } else {
    const method = bufferReadMethod(meta.type, meta.endian);
    lines.push(`  ${name}(): number {`);
    lines.push(`    return this.#buffer!.${method}(this.#offset + ${className}.${name}EncodingOffset());`);
    lines.push('  }');
  }

  lines.push('');
  return lines;
}

function generateDecoderClass(msg: MessageSchema, schemaVersion: number): string {
  const className = `${msg.name}Decoder`;
  const allMetadata = msg.fields.flatMap(extractFieldMetadata);
  const fixedFields = allMetadata.filter(m => m.isFixed);
  const designatorField = fixedFields.find(m => m.name === 'designator');
  const versionField = fixedFields.find(m => m.name === 'version');

  const lines: string[] = [];

  lines.push(`export class ${className} {`);

  lines.push(`  static readonly ENCODED_LENGTH = ${msg.size};`);
  lines.push(`  static readonly SCHEMA_VERSION = ${schemaVersion};`);
  lines.push('');

  for (const meta of allMetadata) {
    lines.push(...generateStaticMetadataMethods(meta));
  }

  lines.push('  #buffer: Buffer | null = null;');
  lines.push('  #offset = 0;');
  lines.push('');

  lines.push(`  wrap(buffer: Buffer, offset: number): ${className} {`);
  lines.push('    this.#buffer = buffer;');
  lines.push('    this.#offset = offset;');
  lines.push('    return this;');
  lines.push('  }');
  lines.push('');

  lines.push('  buffer(): Buffer | null {');
  lines.push('    return this.#buffer;');
  lines.push('  }');
  lines.push('');

  lines.push('  offset(): number {');
  lines.push('    return this.#offset;');
  lines.push('  }');
  lines.push('');

  lines.push('  encodedLength(): number {');
  lines.push(`    return ${className}.ENCODED_LENGTH;`);
  lines.push('  }');
  lines.push('');

  lines.push('  hasEnoughBytes(): boolean {');
  lines.push('    return this.#buffer !== null &&');
  lines.push(`      this.#buffer.length >= this.#offset + ${className}.ENCODED_LENGTH;`);
  lines.push('  }');
  lines.push('');

  for (const meta of allMetadata) {
    lines.push(...generateDecoderGetter(meta, className));
  }

  if (designatorField) {
    lines.push('  isValidDesignator(): boolean {');
    lines.push(`    return this.#buffer![this.#offset + ${className}.designatorEncodingOffset()] === ${className}.designatorConstantValue();`);
    lines.push('  }');
    lines.push('');
  }

  if (versionField) {
    lines.push('  isValidVersion(): boolean {');
    lines.push(`    return this.#buffer![this.#offset + ${className}.versionEncodingOffset()] === ${className}.versionConstantValue();`);
    lines.push('  }');
    lines.push('');
  }

  lines.push('  isValid(): boolean {');
  const checks = ['this.hasEnoughBytes()'];
  if (designatorField) checks.push('this.isValidDesignator()');
  if (versionField) checks.push('this.isValidVersion()');
  lines.push(`    return ${checks.join(' && ')};`);
  lines.push('  }');
  lines.push('');

  lines.push(...generateToObjectMethod(msg, className));
  lines.push('');

  if (designatorField) {
    lines.push('  static startsWithBinaryHeader(buffer: Buffer, offset: number = 0): boolean {');
    lines.push(`    return buffer.length > offset && buffer[offset] === ${className}.designatorConstantValue();`);
    lines.push('  }');
    lines.push('');

    lines.push('  static peekDesignator(buffer: Buffer, offset: number = 0): number | null {');
    lines.push('    return buffer.length > offset ? buffer[offset] : null;');
    lines.push('  }');
  }

  lines.push('}');

  return lines.join('\n');
}

function generateCodecFile(msg: MessageSchema, schema: ProtocolSchema): string {
  const lines: string[] = [];

  lines.push(`// Generated from ${schema.name} protocol v${schema.version} - DO NOT EDIT`);
  lines.push('//');
  lines.push('// Performance contract: encoder write paths are intentionally unchecked.');
  lines.push('// Callers must validate inputs against generated *MinValue/*MaxValue metadata');
  lines.push('// before calling encode methods. Out-of-range values are truncated on the wire.');
  lines.push('');

  lines.push('/**');
  lines.push(` * ${msg.description || msg.name}`);
  lines.push(' *');
  lines.push(' * Wire format:');
  for (const f of msg.fields) {
    if (f.kind === 'bitfield') {
      const fieldNames = f.fields.map(bf => bf.name).join(', ');
      lines.push(` * - Byte ${f.offset}: Flags (${fieldNames})`);
    } else {
      const size = typeSize(f.type);
      const range = size === 1 ? `Byte ${f.offset}` : `Bytes ${f.offset}-${f.offset + size - 1}`;
      const endianNote = f.endian === 'big' && size > 1 ? ' BE' : f.endian === 'little' && size > 1 ? ' LE' : '';
      lines.push(` * - ${range}: ${f.name} (${f.type}${endianNote})`);
    }
  }
  lines.push(' */');
  lines.push('');

  lines.push(generateEncoderClass(msg, schema.version));
  lines.push('');

  lines.push(generateDecoderClass(msg, schema.version));

  const bitfieldGroup = msg.fields.find(f => f.kind === 'bitfield') as BitfieldGroup | undefined;
  if (bitfieldGroup) {
    lines.push('');

    for (const bf of bitfieldGroup.fields) {
      if (bf.bits === 1) {
        const fnName = `has${bf.name.charAt(0).toUpperCase()}${bf.name.slice(1)}`;
        lines.push(`export function ${fnName}(flagsByte: number): boolean {`);
        lines.push(`  return (flagsByte & ${formatHex(bf.mask)}) !== 0;`);
        lines.push('}');
        lines.push('');
      } else {
        const fnName = `extract${bf.name.charAt(0).toUpperCase()}${bf.name.slice(1)}`;
        lines.push(`export function ${fnName}(flagsByte: number): number {`);
        lines.push(`  return flagsByte & ${formatHex(bf.mask)};`);
        lines.push('}');
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

export interface FlyweightGeneratorOutput {
  readonly files: ReadonlyArray<{
    readonly filename: string;
    readonly content: string;
  }>;
}

export function generateFlyweightCodecs(schema: ProtocolSchema): FlyweightGeneratorOutput {
  const files = schema.messages.map(msg => ({
    filename: `${toKebabCase(msg.name)}-codec.ts`,
    content: generateCodecFile(msg, schema),
  }));

  return { files };
}
