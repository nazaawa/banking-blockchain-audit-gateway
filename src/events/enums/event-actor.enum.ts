export enum EventActorRole {
  REFUND_OPERATOR = 'REFUND_OPERATOR',
  REFUND_APPROVER = 'REFUND_APPROVER',
  SYSTEM = 'SYSTEM',
}

export enum EventActionOrigin {
  API = 'API',
  RETRY_WORKER = 'RETRY_WORKER',
  SYSTEM = 'SYSTEM',
}
