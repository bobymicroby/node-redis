import {
  protocol,
  message,
  fixed,
  field,
  bitfield,
} from '../codegen/schema';

export const BinaryHeadersProtocolV1 = protocol(
  'BinaryHeaders',
  1,
  [
    message('RequestHeader', 16, [
      fixed('designator', 'uint8', 0, 0xAE, { sinceVersion: 0 }),
      fixed('version', 'uint8', 1, 0x01, { sinceVersion: 0 }),
      field('slot', 'uint16', 2, {
        endian: 'big',
        min: 0,
        max: 0x3FFF,
        nullValue: 0xFFFF,
        sinceVersion: 0
      }),
      field('length', 'uint32', 4, {
        endian: 'big',
        min: 0,
        max: 0xFFFFFFFF,
        sinceVersion: 0
      }),
      field('commandCount', 'uint8', 8, {
        min: 1,
        max: 0x7F,
        sinceVersion: 0
      }),
      field('requestId', 'uint32', 9, {
        endian: 'big',
        min: 0,
        max: 0xFFFFFFFF,
        sinceVersion: 0
      }),
    ], 'Request header sent from client to proxy'),

    message('ResponseHeader', 16, [
      fixed('designator', 'uint8', 0, 0xAE, { sinceVersion: 0 }),
      fixed('version', 'uint8', 1, 0x01, { sinceVersion: 0 }),
      field('length', 'uint32', 4, {
        endian: 'big',
        min: 0,
        max: 0xFFFFFFFF,
        sinceVersion: 0
      }),
      bitfield('flags', 8, [
        { name: 'commandCount', bits: 7, mask: 0x7F, sinceVersion: 0 },
        { name: 'protocolError', bits: 1, mask: 0x80, sinceVersion: 0 },
      ], 0),
      field('requestId', 'uint32', 9, {
        endian: 'big',
        min: 0,
        max: 0xFFFFFFFF,
        sinceVersion: 0
      }),
    ], 'Response header sent from proxy to client'),
  ],
  'Binary headers protocol for optimized Redis cluster communication via DMC proxy'
);
