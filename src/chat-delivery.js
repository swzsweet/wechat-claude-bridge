export async function deliverToChats(message, senders) {
  if (!senders.length) return;
  const results = await Promise.allSettled(senders.map((send) => send(message)));
  for (const result of results) {
    if (result.status === 'rejected') console.error('Channel send:', result.reason?.message);
  }
  if (results.every((result) => result.status === 'rejected')) throw new Error('All chat channels failed to send');
}
