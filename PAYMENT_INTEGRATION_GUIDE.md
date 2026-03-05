# 💳 Payment Integration Guide

## Overview

This guide covers payment integration for Phone Party across web, iOS, and Android platforms. The app supports multiple payment providers and methods.

## Current Status

### ✅ Implemented
- Payment provider abstraction layer
- Multi-platform payment routing (Web → Stripe, iOS → Apple IAP, Android → Google Play)
- Payment client with platform detection
- Simulated payment flow for testing
- Database schema for purchases and subscriptions
- Server-side payment endpoints

### ⚠️ Pending Implementation
- Stripe API integration (web payments)
- Google Play Billing integration (Android native)
- Apple IAP integration (iOS native)
- Webhook handlers for provider callbacks
- Receipt verification for mobile platforms

## Payment Providers

### Web Platform (PWA) - Stripe

**Status**: Framework ready, API integration needed

**Products**:
- Party Pass: £3.99 one-time purchase
- Pro Monthly: £9.99/month subscription

**Payment Methods Supported**:
- Credit/debit cards (Visa, Mastercard, Amex)
- Google Pay (on supported browsers)
- Apple Pay (on Safari/iOS)

**Integration Steps**:

1. **Install Stripe SDK**:
   ```bash
   npm install stripe @stripe/stripe-js
   ```

2. **Set environment variables**:
   ```bash
   # .env file
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_PUBLISHABLE_KEY=pk_live_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   ```

3. **Update payment-provider.js**:
   ```javascript
   // Uncomment and implement Stripe integration
   const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
   
   async function processStripePayment(paymentRequest) {
     const { amount, currency, paymentToken } = paymentRequest;
     
     const paymentIntent = await stripe.paymentIntents.create({
       amount,
       currency: currency || 'gbp',
       payment_method: paymentToken,
       confirm: true,
       metadata: {
         userId: paymentRequest.userId,
         productId: paymentRequest.productId
       }
     });
     
     return {
       transactionId: `stripe_${Date.now()}_${paymentIntent.id}`,
       providerTransactionId: paymentIntent.id,
       status: paymentIntent.status
     };
   }
   ```

4. **Add webhook handler** (server.js):
   ```javascript
   app.post('/api/stripe/webhook', express.raw({type: 'application/json'}), (req, res) => {
     const sig = req.headers['stripe-signature'];
     let event;
     
     try {
       event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
     } catch (err) {
       return res.status(400).send(`Webhook Error: ${err.message}`);
     }
     
     // Handle the event
     switch (event.type) {
       case 'payment_intent.succeeded':
         // Update purchase status
         break;
       case 'customer.subscription.created':
         // Create subscription record
         break;
       case 'customer.subscription.deleted':
         // Cancel subscription
         break;
     }
     
     res.json({received: true});
   });
   ```

5. **Update client-side** (payment-client.js):
   ```javascript
   // Add Stripe.js library
   const stripe = await loadStripe(STRIPE_PUBLISHABLE_KEY);
   
   // Create payment intent and confirm
   const {error, paymentIntent} = await stripe.confirmCardPayment(
     clientSecret,
     {payment_method: paymentMethodId}
   );
   ```

### Android Platform - Google Play Billing

**Status**: Not implemented (native app only)

**Note**: For PWA deployment, use Stripe (web payments). Google Play Billing only needed for native Android app.

**Integration Steps** (if building native app):

1. **Add Google Play Billing Library** (build.gradle):
   ```gradle
   implementation 'com.android.billingclient:billing:5.0.0'
   ```

2. **Set up Google Play Console**:
   - Create in-app products
   - Set pricing for Party Pass and Pro Monthly
   - Configure subscription settings

3. **Implement BillingClient**:
   ```javascript
   // payment-provider.js
   async function processGooglePlayPayment(paymentRequest) {
     const { paymentToken } = paymentRequest;
     
     // Verify purchase with Google Play API
     const {google} = require('googleapis');
     const androidPublisher = google.androidpublisher('v3');
     
     const response = await androidPublisher.purchases.products.get({
       packageName: 'com.phoneparty.app',
       productId: paymentRequest.productId,
       token: paymentToken
     });
     
     if (response.data.purchaseState !== 0) {
       throw new Error('Purchase not completed');
     }
     
     return {
       transactionId: `google_${Date.now()}_${response.data.orderId}`,
       providerTransactionId: response.data.orderId,
       status: 'verified'
     };
   }
   ```

4. **Real-time Developer Notifications**:
   - Set up Pub/Sub topic in Google Cloud
   - Configure webhook endpoint
   - Handle subscription lifecycle events

### iOS Platform - Apple In-App Purchase

**Status**: Not implemented (native app only)

**Note**: For PWA deployment, use Stripe (web payments). Apple IAP only needed for native iOS app.

**Integration Steps** (if building native app):

1. **Configure App Store Connect**:
   - Create in-app purchase products
   - Set pricing for Party Pass and Pro Monthly
   - Submit for review

2. **Implement StoreKit**:
   ```javascript
   // payment-provider.js
   async function processAppleIAPPayment(paymentRequest) {
     const { paymentToken } = paymentRequest;
     
     // Verify receipt with Apple
     const response = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
       method: 'POST',
       headers: {'Content-Type': 'application/json'},
       body: JSON.stringify({
         'receipt-data': paymentToken,
         'password': process.env.APPLE_IAP_SHARED_SECRET
       })
     });
     
     const data = await response.json();
     
     if (data.status !== 0) {
       throw new Error('Receipt validation failed');
     }
     
     return {
       transactionId: `apple_${Date.now()}_${data.receipt.transaction_id}`,
       providerTransactionId: data.receipt.transaction_id,
       status: 'verified'
     };
   }
   ```

3. **Server-to-Server Notifications**:
   - Configure notification endpoint in App Store Connect
   - Handle subscription lifecycle events
   - Process refunds and renewals

## Testing Payments

### Test Mode (Current)

The app currently uses **simulated payments** for testing:

```javascript
// Simulated payment flow
// - 95% success rate
// - 5% failure rate (random)
// - No real money charged
```

**To test simulated payments**:
1. Select any tier (Party Pass or Pro Monthly)
2. Complete purchase flow
3. Payment will succeed (95% chance) or fail (5% chance)
4. Check browser console for payment logs
5. Verify entitlement in database

### Stripe Test Mode

Once Stripe is integrated, use test mode:

**Test Cards**:
```
Success: 4242 4242 4242 4242
Declined: 4000 0000 0000 0002
3D Secure: 4000 0027 6000 3184
```

**Test Environment**:
1. Use Stripe test keys (`sk_test_...`)
2. Use test mode in Stripe Dashboard
3. No real charges will occur
4. Test webhook events in Stripe CLI

### Production Testing

Before launching:

1. **Small Transaction Test**:
   - Make real £0.50 test purchase
   - Verify charge appears in Stripe Dashboard
   - Confirm entitlement granted
   - Issue refund

2. **Subscription Test**:
   - Create real subscription (will be charged)
   - Verify subscription active
   - Test cancellation
   - Confirm refund processed

3. **Webhook Test**:
   - Trigger real webhook events
   - Verify server processes correctly
   - Check database updates
   - Monitor error logs

## Product Configuration

### Party Pass - £3.99 One-Time

**Features**:
- 2-hour party unlock
- Up to 4 phones (Free tier: 2)
- Pro DJ mode
- Guest reactions
- Preset messages

**Implementation**:
```javascript
{
  id: 'party_pass',
  name: 'Party Pass',
  price: 3.99,
  currency: 'GBP',
  duration: 7200, // 2 hours in seconds
  type: 'one_time',
  features: ['pro_dj_mode', 'guest_reactions', 'preset_messages']
}
```

### Pro Monthly - £9.99/month

**Features**:
- Unlimited phones (Free: 2, Party Pass: 4)
- Custom messages
- Full DJ tools
- Score system
- Visual packs

**Implementation**:
```javascript
{
  id: 'pro_monthly',
  name: 'Pro Monthly',
  price: 9.99,
  currency: 'GBP',
  interval: 'month',
  type: 'subscription',
  features: ['unlimited_phones', 'custom_messages', 'dj_tools', 'visual_packs']
}
```

## Security Considerations

### Server-Side Validation

**ALWAYS verify payments server-side**:
```javascript
// ❌ NEVER trust client-side payment confirmation
if (clientSaysPaymentSucceeded) {
  grantEntitlement(); // VULNERABLE!
}

// ✅ ALWAYS verify with payment provider
const verified = await verifyPaymentWithProvider(transactionId);
if (verified && verified.status === 'succeeded') {
  grantEntitlement(); // SECURE
}
```

### Receipt Verification

For mobile platforms:
```javascript
// Verify Apple IAP receipt
const appleReceipt = await verifyWithApple(receiptData);

// Verify Google Play purchase
const googlePurchase = await verifyWithGoogle(purchaseToken);
```

### Webhook Signature Validation

**ALWAYS validate webhook signatures**:
```javascript
// Stripe webhook validation
const signature = request.headers['stripe-signature'];
const event = stripe.webhooks.constructEvent(
  request.body,
  signature,
  webhookSecret
);
```

### Environment Variables

**NEVER commit secrets to git**:
```bash
# .env file (in .gitignore)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
APPLE_IAP_SHARED_SECRET=...
GOOGLE_PLAY_SERVICE_ACCOUNT=...
```

## Error Handling

### Common Payment Errors

```javascript
// Insufficient funds
if (error.type === 'card_error' && error.code === 'insufficient_funds') {
  showError('Card declined - insufficient funds');
}

// Network error
if (error.type === 'network_error') {
  showError('Network error - please try again');
}

// Invalid card
if (error.code === 'invalid_card_number') {
  showError('Invalid card number');
}
```

### Retry Logic

```javascript
async function processPaymentWithRetry(paymentRequest, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await processPayment(paymentRequest);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      if (!isRetryable(error)) throw error;
      await delay(1000 * Math.pow(2, i)); // Exponential backoff
    }
  }
}
```

## Monitoring

### Payment Metrics to Track

1. **Success Rate**: % of successful payments
2. **Failure Rate**: % of failed payments
3. **Average Transaction Value**: Average purchase amount
4. **Churn Rate**: % of subscription cancellations
5. **Revenue**: Total revenue by product

### Logging

```javascript
// Log all payment attempts
console.log(`[Payment] User ${userId} attempting ${productId} via ${provider}`);

// Log successes
console.log(`[Payment] SUCCESS: ${transactionId} for ${amount} ${currency}`);

// Log failures
console.error(`[Payment] FAILED: ${error.message} for user ${userId}`);
```

### Alerts

Set up alerts for:
- Payment failure rate > 10%
- Webhook processing errors
- Subscription cancellation spike
- Refund rate increase

## Next Steps

### For PWA Launch (Recommended)

1. **Integrate Stripe** (1-2 days):
   - Install Stripe SDK
   - Configure API keys
   - Implement payment flow
   - Add webhook handler
   - Test with test cards

2. **Test Thoroughly** (1 day):
   - Test all payment methods
   - Verify webhook processing
   - Test error scenarios
   - Confirm entitlements work

3. **Launch** (immediate):
   - Switch to live API keys
   - Monitor first transactions
   - Be ready to handle support requests

### For Native App (Future)

1. **Google Play Billing** (2-3 weeks):
   - Set up products in Play Console
   - Implement BillingClient
   - Test purchase flow
   - Implement receipt verification

2. **Apple IAP** (2-3 weeks):
   - Configure App Store Connect
   - Implement StoreKit
   - Submit for review
   - Implement receipt validation

## Resources

- [Stripe Documentation](https://stripe.com/docs)
- [Google Play Billing](https://developer.android.com/google/play/billing)
- [Apple In-App Purchase](https://developer.apple.com/in-app-purchase/)
- [Payment Security Best Practices](https://stripe.com/docs/security/guide)

## Support

For payment integration issues:
1. Check error logs
2. Verify API keys are correct
3. Test in sandbox/test mode first
4. Contact payment provider support if needed

---

**Ready to integrate payments?** Start with Stripe for web (PWA) deployment.
