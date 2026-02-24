/** Domain type for a provisioned phone number tracked for monthly billing. */
export interface ProvisionedPhoneNumber {
  sid: string;
  tenantId: string;
  phoneNumber: string;
  provisionedAt: string;
  lastBilledAt: string | null;
}
