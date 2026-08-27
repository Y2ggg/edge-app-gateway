const REDEEMED_KEY = 'redeemed';
const MAX_EXPIRATION_AHEAD_MS = 5 * 60 * 1000;

export class EntryTicketRedeemer {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/consume') {
      return new Response(null, { status: 404 });
    }

    let expiresAt;

    try {
      ({ expiresAt } = await request.json());
    } catch {
      return new Response(null, { status: 400 });
    }

    const now = Date.now();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + MAX_EXPIRATION_AHEAD_MS
    ) {
      return new Response(null, { status: 400 });
    }

    const consumed = await this.state.storage.transaction(async transaction => {
      if (await transaction.get(REDEEMED_KEY)) return false;
      await transaction.put(REDEEMED_KEY, expiresAt);
      return true;
    });

    if (!consumed) {
      return new Response(null, { status: 409 });
    }

    await this.state.storage.setAlarm(expiresAt);
    return new Response(null, { status: 204 });
  }

  async alarm() {
    await this.state.storage.deleteAll();
  }
}
