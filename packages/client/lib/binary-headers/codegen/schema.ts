export type Endianness = 'big' | 'little';

export type PrimitiveType = 'uint8' | 'uint16' | 'uint32' | 'int8' | 'int16' | 'int32';

export interface Bitfield {
  readonly name: string;
  readonly bits: number;
  readonly mask: number;
  readonly sinceVersion?: number;
}

export interface Validation {
  readonly min?: number;
  readonly max?: number;
}

export interface FixedField {
  readonly kind: 'fixed';
  readonly name: string;
  readonly type: PrimitiveType;
  readonly offset: number;
  readonly endian?: Endianness;
  readonly value: number;
  readonly sinceVersion?: number;
}

export interface VariableField {
  readonly kind: 'variable';
  readonly name: string;
  readonly type: PrimitiveType;
  readonly offset: number;
  readonly endian?: Endianness;
  readonly validation?: Validation;
  readonly nullValue?: number;
  readonly sinceVersion?: number;
}

export interface BitfieldGroup {
  readonly kind: 'bitfield';
  readonly name: string;
  readonly offset: number;
  readonly fields: ReadonlyArray<Bitfield>;
  readonly sinceVersion?: number;
}

export type Field = FixedField | VariableField | BitfieldGroup;



export interface MessageSchema {
  readonly name: string;
  readonly size: number;
  readonly description?: string;
  readonly fields: ReadonlyArray<Field>;
}

export interface ProtocolSchema {
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly messages: ReadonlyArray<MessageSchema>;
}

export interface FieldOptions {
  readonly endian?: Endianness;
  readonly min?: number;
  readonly max?: number;
  readonly nullValue?: number;
  readonly sinceVersion?: number;
}

export function field(name: string, type: PrimitiveType, offset: number, options?: FieldOptions): VariableField {
  const { endian, min, max, nullValue, sinceVersion } = options ?? {};
  const validation = buildValidation(min, max);
  return { kind: 'variable', name, type, offset, endian, validation, nullValue, sinceVersion };
}

function buildValidation(min: number | undefined, max: number | undefined): Validation | undefined {
  if (min === undefined && max === undefined) return undefined;
  const result: { min?: number; max?: number } = {};
  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;
  return result;
}

export interface FixedFieldOptions {
  readonly endian?: Endianness;
  readonly sinceVersion?: number;
}

export function fixed(
  name: string,
  type: PrimitiveType,
  offset: number,
  value: number,
  options?: FixedFieldOptions
): FixedField {
  const { endian, sinceVersion } = options ?? {};
  return { kind: 'fixed', name, type, offset, value, endian, sinceVersion };
}

export interface BitfieldEntry {
  readonly name: string;
  readonly bits: number;
  readonly mask: number;
  readonly sinceVersion?: number;
}

export function bitfield(
  name: string,
  offset: number,
  fields: ReadonlyArray<BitfieldEntry>,
  sinceVersion?: number
): BitfieldGroup {
  return { kind: 'bitfield', name, offset, fields, sinceVersion };
}



export function message(name: string, size: number, fields: ReadonlyArray<Field>, description?: string): MessageSchema {
  return { name, size, fields, description };
}

export function protocol(
  name: string,
  version: number,
  messages: ReadonlyArray<MessageSchema>,
  description?: string
): ProtocolSchema {
  return { name, version, messages, description };
}
