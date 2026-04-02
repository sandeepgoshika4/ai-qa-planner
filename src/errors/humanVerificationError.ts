export class HumanVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanVerificationRequiredError";
  }
}