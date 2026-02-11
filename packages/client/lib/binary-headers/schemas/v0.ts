import {
  protocol,
  message,
  fixed,
  field,
  bitfield,
} from '../codegen/schema';

export const BinaryHeadersProtocolV0 = protocol(
  'BinaryHeaders',
  0,
  [
    message('RequestHeader', 10, [
      fixed('designator', 'uint8', 0, 0x80),
      field('length', 'uint32', 1, { endian: 'big', min: 0, max: 0x7FFFFFFF }),
      field('commandCount', 'uint8', 5, { min: 1, max: 127 }),
      field('slot', 'uint16', 6, { endian: 'big', min: 0, max: 0x3FFF, nullValue: 0xFFFF }),
      field('clientIdx', 'uint16', 8, { endian: 'big', min: 0, max: 0xFFFF }),
    ], 'Request header sent from client to server (v0 format)'),

    message('ResponseHeader', 8, [
      fixed('designator', 'uint8', 0, 0x80),
      field('length', 'uint32', 1, { endian: 'big', min: 0, max: 0x7FFFFFFF }),
      bitfield('flags', 5, [
        { name: 'commandCount', bits: 7, mask: 0x7F },
        { name: 'protocolError', bits: 1, mask: 0x80 },
      ]),
      field('clientIdx', 'uint16', 6, { endian: 'big', min: 0, max: 0xFFFF }),
    ], 'Response header sent from server to client (v0 format)'),
  ],
  'Binary headers protocol v0 (original 0x80 format)'
);
