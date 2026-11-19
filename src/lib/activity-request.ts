export type ActivityIdentity = string | null;

export interface ActivityRequestToken {
  readonly identity: ActivityIdentity;
  readonly sequence: number;
}

/** Keeps responses from an old identity or superseded refresh out of the view. */
export class ActivityRequestGuard {
  private identity: ActivityIdentity = null;
  private sequence = 0;

  setIdentity(identity: ActivityIdentity): boolean {
    if (identity === this.identity) return false;
    this.identity = identity;
    this.invalidate();
    return true;
  }

  invalidate(): void {
    this.sequence += 1;
  }

  begin(): ActivityRequestToken {
    this.sequence += 1;
    return { identity: this.identity, sequence: this.sequence };
  }

  isCurrent(token: ActivityRequestToken): boolean {
    return token.identity === this.identity && token.sequence === this.sequence;
  }
}
