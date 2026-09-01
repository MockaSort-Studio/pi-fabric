export interface ResidentOwnerObservation {
  claimed: boolean;
  observedOwner: boolean;
  closeInput: boolean;
}

export function observeResidentOwner(
  ownerPid: number | undefined,
  childPid: number | undefined,
  claimed: boolean,
): ResidentOwnerObservation {
  if (childPid === undefined) {
    return { claimed, observedOwner: ownerPid !== undefined, closeInput: false };
  }
  if (ownerPid === childPid) {
    return { claimed: true, observedOwner: true, closeInput: false };
  }
  if (ownerPid !== undefined) {
    return { claimed, observedOwner: true, closeInput: true };
  }
  return { claimed, observedOwner: false, closeInput: claimed };
}
