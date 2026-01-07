/**
 * Binary headers protocol constants.
 *
 * These values are defined by the binary headers specification for
 * communication between node-redis and DMC proxy/Redis.
 */
export const BINHDR = {
  /** Binary header designator byte - must not collide with RESP type designators */
  DESIGNATOR: 0x80,

  /** Size of request binary header in bytes */
  REQUEST_HEADER_SIZE: 10,

  /** Size of response binary header in bytes */
  RESPONSE_HEADER_SIZE: 8,

  /** Maximum number of commands that can be packed in a single binary header frame */
  MAX_COMMANDS_PER_PACK: 127,

  /** Maximum payload length in bytes (high bit reserved) */
  MAX_PAYLOAD_LENGTH: 0x7FFFFFFF,

  /** Special slot value indicating no slot / unknown slot */
  SLOT_NO_SLOT: 0xFFFF,

  /** Maximum valid slot number (Redis cluster has 16384 slots: 0-16383) */
  SLOT_MAX_VALID: 0x3FFF,

  /** Maximum client index value (16-bit unsigned) */
  MAX_CLIENT_IDX: 0xFFFF,

  /** Bit mask for protocol error indicator in response NCMD/FLAGS byte */
  PROTOCOL_ERROR_BIT: 0x80,

  /** Bit mask to extract command count from response NCMD/FLAGS byte */
  COMMAND_COUNT_MASK: 0x7F,
} as const;

/** Type for the BINHDR constants object */
export type BINHDR = typeof BINHDR;
