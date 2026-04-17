export type StreamGeneration = {
  bumpSession: (sessionID: string) => void
  bumpPart: (sessionID: string, partID: string) => void
  captureSession: (sessionID: string) => number
  capturePart: (sessionID: string, partID: string) => number
  isSessionCurrent: (sessionID: string, generation: number) => boolean
  isPartCurrent: (sessionID: string, partID: string, generation: number) => boolean
}

export function createStreamGeneration(): StreamGeneration {
  const sessionGen = new Map<string, number>()
  const partGen = new Map<string, number>()

  function sessionValue(sessionID: string): number {
    return sessionGen.get(sessionID) ?? 0
  }

  function partValue(sessionID: string, partID: string): number {
    return partGen.get(`${sessionID}:${partID}`) ?? 0
  }

  return {
    bumpSession: (sessionID) => {
      sessionGen.set(sessionID, sessionValue(sessionID) + 1)
    },
    bumpPart: (sessionID, partID) => {
      partGen.set(`${sessionID}:${partID}`, partValue(sessionID, partID) + 1)
    },
    captureSession: sessionValue,
    capturePart: partValue,
    isSessionCurrent: (sessionID, generation) => sessionValue(sessionID) === generation,
    isPartCurrent: (sessionID, partID, generation) => partValue(sessionID, partID) === generation,
  }
}
