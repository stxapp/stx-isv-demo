// Lets code outside the Privy provider's React tree (sign-out in App) call
// Privy. Set by <PrivyBridge/> when Privy is the app's login; null otherwise.
export const privyActions: { logout: (() => Promise<void>) | null } = { logout: null };
