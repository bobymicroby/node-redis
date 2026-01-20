import {
  protocol,
  message,
  constant,
  fixed,
  field,
  bitfield,
} from '../codegen/schema';

export const BinaryHeadersProtocolV0 = protocol(
  'BinaryHeaders',
  0,
  [
    constant('DESIGNATOR', 0x80, 'Magic byte identifying binary header frames'),
    constant('REQUEST_HEADER_SIZE', 10, 'Size of request header in bytes'),
    constant('RESPONSE_HEADER_SIZE', 8, 'Size of response header in bytes'),
    constant('MAX_COMMANDS_PER_PACK', 127, 'Maximum commands in a single pack'),
    constant('MAX_PAYLOAD_LENGTH', 0x7FFFFFFF, 'Maximum payload length'),
    constant('SLOT_NO_SLOT', 0xFFFF, 'Special value for no slot'),
    constant('SLOT_MAX_VALID', 0x3FFF, 'Maximum valid slot number (16383)'),
    constant('MAX_CLIENT_IDX', 0xFFFF, 'Maximum client index'),
    constant('PROTOCOL_ERROR_BIT', 0x80, 'Bit flag for protocol error in response'),
    constant('COMMAND_COUNT_MASK', 0x7F, 'Mask for extracting command count from flags'),
  ],
  [
    message('RequestHeader', 10, [
      fixed('designator', 'uint8', 0, 0x80),
      field('length', 'uint32', 1, { endian: 'big', min: 0, max: 0x7FFFFFFF }),
      field('commandCount', 'uint8', 5, { min: 1, max: 127 }),
      field('slot', 'uint16', 6, { endian: 'big', min: 0, max: 0xFFFF }),
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
