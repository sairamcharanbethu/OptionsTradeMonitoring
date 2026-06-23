export function buildCommandReplayEventsQuery(userId: number, positionId: number | string, signalId?: number | string | null) {
  return {
    text: `SELECT id, user_id, signal_id, position_id, event_type, message, metadata, created_at
       FROM trade_events
       WHERE user_id = $1
         AND (
           position_id = $2
           OR ($3::integer IS NOT NULL AND signal_id = $3::integer)
         )
       ORDER BY created_at ASC, id ASC`,
    values: [userId, positionId, signalId || null]
  };
}
