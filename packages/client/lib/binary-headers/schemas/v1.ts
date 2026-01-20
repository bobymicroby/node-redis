import {
  protocol,
  message,
  constant,
  fixed,
  field,
  bitfield,
  padding,
} from '../codegen/schema';

export const BinaryHeadersProtocolV1 = protocol(
  'BinaryHeaders',
  1,
  [
    constant('DESIGNATOR', 0xAE, 'Magic byte identifying binary header frames'),
    constant('VERSION', 0x01, 'Protocol version'),
    constant('REQUEST_HEADER_SIZE', 16, 'Size of request header in bytes'),
    constant('RESPONSE_HEADER_SIZE', 16, 'Size of response header in bytes'),
    constant('MAX_COMMANDS_PER_PACK', 127, 'Maximum commands in a single pack'),
    constant('MAX_PAYLOAD_LENGTH', 0xFFFFFFFF, 'Maximum payload length'),
    constant('MAX_REQUEST_ID', 0xFFFFFFFF, 'Maximum request ID'),
    constant('SLOT_NO_SLOT', 0xFFFF, 'Sentinel value for keyless commands'),
    constant('SLOT_MAX_VALID', 0x3FFF, 'Maximum valid slot number (16383)'),
    constant('PROTOCOL_ERROR_BIT', 0x80, 'Bit flag for protocol error in response'),
    constant('COMMAND_COUNT_MASK', 0x7F, 'Mask for extracting command count from flags'),
  ],
  [
    message('RequestHeader', 16, [
      fixed('designator', 'uint8', 0, 0xAE),
      fixed('version', 'uint8', 1, 0x01),
      field('slot', 'uint16', 2, { endian: 'big', min: 0, max: 0x3FFF }),
      field('length', 'uint32', 4, { endian: 'big', min: 0, max: 0xFFFFFFFF }),
      field('commandCount', 'uint8', 8, { min: 1, max: 127 }),
      field('requestId', 'uint32', 9, { endian: 'big', min: 0, max: 0xFFFFFFFF }),
      padding(13, 3),
    ], 'Request header sent from client to proxy'),

    message('ResponseHeader', 16, [
      fixed('designator', 'uint8', 0, 0xAE),
      fixed('version', 'uint8', 1, 0x01),
      padding(2, 2),
      field('length', 'uint32', 4, { endian: 'big', min: 0, max: 0xFFFFFFFF }),
      bitfield('flags', 8, [
        { name: 'commandCount', bits: 7, mask: 0x7F },
        { name: 'protocolError', bits: 1, mask: 0x80 },
      ]),
      field('requestId', 'uint32', 9, { endian: 'big', min: 0, max: 0xFFFFFFFF }),
      padding(13, 3),
    ], 'Response header sent from proxy to client'),
  ],
  'Binary headers protocol for optimized Redis cluster communication via DMC proxy'
);
