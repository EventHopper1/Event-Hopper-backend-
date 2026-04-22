// ─────────────────────────────────────────────────────────────────
// EVENT HOPPER — BACKEND API
// Node.js + Express + Stripe + Supabase
//
// SETUP:
//   npm install express stripe @supabase/supabase-js resend cors dotenv
//
// ENV VARIABLES NEEDED (.env):
//   STRIPE_SECRET_KEY=sk_live_...
//   STRIPE_WEBHOOK_SECRET=whsec_...
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY=eyJ...
//   RESEND_API_KEY=re_...
//   PLATFORM_FEE_PERCENT=5
//   CLIENT_URL=https://yourdomain.com
//   PORT=4000
// ─────────────────────────────────────────────────────────────────

import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const PLATFORM_FEE_PCT = parseFloat(process.env.PLATFORM_FEE_PERCENT || "5") / 100;
const BOOTH_LOCK_MINUTES = 10;

// ── Middleware ──
// Stripe webhooks need raw body — must come BEFORE express.json()
app.use("/api/webhooks/stripe", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL }));

// ─────────────────────────────────────────────────────────────────
// HELPER — Calculate fee split
// ─────────────────────────────────────────────────────────────────
function calculateFees(boothPrice) {
  const stripeFee = parseFloat((boothPrice * 0.029 + 0.30).toFixed(2));
  const platformFee = parseFloat((boothPrice * PLATFORM_FEE_PCT).toFixed(2));
  const organizerAmount = parseFloat((boothPrice - stripeFee - platformFee).toFixed(2));
  const totalCharged = boothPrice;
  return { totalCharged, stripeFee, platformFee, organizerAmount };
}

// ─────────────────────────────────────────────────────────────────
// HELPER — Generate confirmation number
// ─────────────────────────────────────────────────────────────────
function generateConfirmationNumber(eventId, boothId) {
  const timestamp = Date.now().toString().slice(-5);
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `EH-${timestamp}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────
// HELPER — Generate QR code data string
// ─────────────────────────────────────────────────────────────────
function generateQRData(bookingId, confirmationNumber, eventId) {
  return JSON.stringify({ bookingId, confirmationNumber, eventId, platform: "EventHopper" });
}

// ─────────────────────────────────────────────────────────────────
// ROUTE 0 — Find or create a guest vendor from checkout info
// POST /api/vendors/find-or-create
// Body: { email, fullName, businessName, phone, whatTheySell }
//
// Called BEFORE the booth lock — creates a guest user record
// if one doesn't already exist for this email.
// No password required — account_type = "guest"
// ─────────────────────────────────────────────────────────────────
app.post("/api/vendors/find-or-create", async (req, res) => {
  const { email, fullName, businessName, phone, whatTheySell } = req.body;

  if (!email || !fullName) {
    return res.status(400).json({ error: "email and fullName are required" });
  }

  try {
    // 1. Check if user already exists by email
    const { data: existingUser } = await supabase
      .from("users")
      .select("*, vendor_profiles(*)")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (existingUser) {
      // User exists — update their vendor profile with latest checkout info
      await supabase.from("vendor_profiles").update({
        business_name: businessName || existingUser.vendor_profiles?.business_name,
        what_they_sell: whatTheySell || existingUser.vendor_profiles?.what_they_sell,
        phone: phone || existingUser.vendor_profiles?.phone,
        last_booked_at: new Date().toISOString(),
      }).eq("user_id", existingUser.id);

      console.log(`♻️  Returning vendor found: ${email}`);
      return res.status(200).json({
        success: true,
        vendorId: existingUser.id,
        isReturning: true,
        message: "Welcome back! Your details have been updated.",
      });
    }

    // 2. New vendor — create guest user record (no password)
    const { data: newUser, error: userError } = await supabase
      .from("users")
      .insert({
        email: email.toLowerCase().trim(),
        full_name: fullName,
        phone: phone || null,
        role: "vendor",
        account_type: "guest",       // guest = no password yet
        password_hash: null,          // NULLABLE — no password required
        is_verified: false,
        is_active: true,
        account_claimed: false,
      })
      .select()
      .single();

    if (userError) throw userError;

    // 3. Create vendor profile from checkout data
    const { error: profileError } = await supabase
      .from("vendor_profiles")
      .insert({
        user_id: newUser.id,
        business_name: businessName || null,
        what_they_sell: whatTheySell || null,
        phone: phone || null,
        total_bookings: 0,
        total_spent: 0,
        source: "checkout",
        first_booked_at: new Date().toISOString(),
        last_booked_at: new Date().toISOString(),
      });

    if (profileError) throw profileError;

    // 4. Generate claim token so vendor can optionally create a full account later
    const claimToken = `claim_${newUser.id}_${Date.now()}`;
    const claimExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    await supabase.from("users").update({
      claim_token: claimToken,
      claim_token_expires: claimExpiry,
    }).eq("id", newUser.id);

    console.log(`✅ New guest vendor created: ${email}`);
    return res.status(201).json({
      success: true,
      vendorId: newUser.id,
      isReturning: false,
      claimToken, // Included in confirmation email so vendor can optionally claim account
      message: "Guest vendor account created from checkout.",
    });

  } catch (err) {
    console.error("Find or create vendor error:", err);
    return res.status(500).json({ error: "Failed to create vendor record" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 0b — Claim a guest account (set password)
// POST /api/vendors/claim-account
// Body: { claimToken, password }
// Called when vendor clicks "Create Account" on confirmation page
// ─────────────────────────────────────────────────────────────────
app.post("/api/vendors/claim-account", async (req, res) => {
  const { claimToken, password } = req.body;

  if (!claimToken || !password) {
    return res.status(400).json({ error: "claimToken and password are required" });
  }

  try {
    // 1. Find user by claim token
    const { data: user, error } = await supabase
      .from("users")
      .select("*")
      .eq("claim_token", claimToken)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: "Invalid or expired claim token" });
    }

    // 2. Check token hasn't expired
    if (new Date(user.claim_token_expires) < new Date()) {
      return res.status(400).json({ error: "Claim token has expired. Please contact support." });
    }

    // 3. Set password via Supabase Auth and upgrade to registered account
    // In production: hash password and update auth.users via Supabase admin client
    // const passwordHash = await bcrypt.hash(password, 10);

    await supabase.from("users").update({
      account_type: "registered",
      account_claimed: true,
      is_verified: true,
      claim_token: null,
      claim_token_expires: null,
    }).eq("id", user.id);

    console.log(`🎉 Guest account claimed: ${user.email}`);
    return res.status(200).json({
      success: true,
      message: "Account created successfully! You can now log in.",
      email: user.email,
    });

  } catch (err) {
    console.error("Claim account error:", err);
    return res.status(500).json({ error: "Failed to claim account" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 1 — Lock a booth during checkout
// POST /api/bookings/lock
// Body: { boothId, vendorId }
// ─────────────────────────────────────────────────────────────────
app.post("/api/bookings/lock", async (req, res) => {
  const { boothId, vendorId } = req.body;

  if (!boothId || !vendorId) {
    return res.status(400).json({ error: "boothId and vendorId are required" });
  }

  try {
    // 1. Fetch the booth
    const { data: booth, error: fetchError } = await supabase
      .from("booths")
      .select("*")
      .eq("id", boothId)
      .single();

    if (fetchError || !booth) {
      return res.status(404).json({ error: "Booth not found" });
    }

    // 2. Check if booth is available
    if (booth.status === "taken") {
      return res.status(409).json({ error: "This booth has already been booked" });
    }

    // 3. Check if booth is locked by someone else
    if (booth.status === "locked" && booth.locked_by !== vendorId) {
      const lockExpiry = new Date(booth.locked_until);
      if (lockExpiry > new Date()) {
        const minutesLeft = Math.ceil((lockExpiry - new Date()) / 60000);
        return res.status(409).json({
          error: `This booth is currently being reserved by another vendor. Try again in ${minutesLeft} minute(s).`,
        });
      }
    }

    // 4. Lock the booth for BOOTH_LOCK_MINUTES
    const lockedUntil = new Date(Date.now() + BOOTH_LOCK_MINUTES * 60 * 1000).toISOString();

    const { error: lockError } = await supabase
      .from("booths")
      .update({ status: "locked", locked_by: vendorId, locked_until: lockedUntil })
      .eq("id", boothId);

    if (lockError) throw lockError;

    return res.status(200).json({
      success: true,
      message: "Booth locked successfully",
      lockedUntil,
      lockDurationMinutes: BOOTH_LOCK_MINUTES,
      booth: { id: booth.id, booth_number: booth.booth_number, price: booth.price, tier: booth.tier },
    });

  } catch (err) {
    console.error("Lock booth error:", err);
    return res.status(500).json({ error: "Failed to lock booth" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 2 — Create Stripe Payment Intent
// POST /api/payments/create-intent
// Body: { boothId, vendorId, eventId }
// ─────────────────────────────────────────────────────────────────
app.post("/api/payments/create-intent", async (req, res) => {
  const { boothId, vendorId, eventId } = req.body;

  if (!boothId || !vendorId || !eventId) {
    return res.status(400).json({ error: "boothId, vendorId, and eventId are required" });
  }

  try {
    // 1. Fetch booth + event + organizer in parallel
    const [boothRes, eventRes, vendorRes] = await Promise.all([
      supabase.from("booths").select("*").eq("id", boothId).single(),
      supabase.from("events").select("*, organizer_profiles(stripe_account_id)").eq("id", eventId).single(),
      supabase.from("users").select("*, vendor_profiles(*)").eq("id", vendorId).single(),
    ]);

    if (boothRes.error || !boothRes.data) return res.status(404).json({ error: "Booth not found" });
    if (eventRes.error || !eventRes.data) return res.status(404).json({ error: "Event not found" });
    if (vendorRes.error || !vendorRes.data) return res.status(404).json({ error: "Vendor not found" });

    const booth = boothRes.data;
    const event = eventRes.data;
    const vendor = vendorRes.data;
    const organizerStripeAccount = event.organizer_profiles?.stripe_account_id;

    // 2. Verify booth is still locked by this vendor
    if (booth.status !== "locked" || booth.locked_by !== vendorId) {
      return res.status(409).json({ error: "Booth lock expired. Please select your booth again." });
    }

    // 3. Calculate fees
    const { totalCharged, stripeFee, platformFee, organizerAmount } = calculateFees(booth.price);
    const amountInCents = Math.round(totalCharged * 100);
    const platformFeeInCents = Math.round(platformFee * 100);

    // 4. Create Stripe Payment Intent with Connect
    const paymentIntentData = {
      amount: amountInCents,
      currency: "usd",
      metadata: {
        boothId,
        vendorId,
        eventId,
        eventName: event.name,
        boothNumber: booth.booth_number.toString(),
        vendorEmail: vendor.email,
      },
      receipt_email: vendor.email,
      description: `${event.name} — Booth #${booth.booth_number}`,
    };

    // If organizer has connected Stripe account, use Connect to split payment
    if (organizerStripeAccount) {
      paymentIntentData.application_fee_amount = platformFeeInCents;
      paymentIntentData.transfer_data = { destination: organizerStripeAccount };
    }

    const paymentIntent = await stripe.paymentIntents.create(paymentIntentData);

    // 5. Create a pending booking record
    const confirmationNumber = generateConfirmationNumber(eventId, boothId);
    const qrData = generateQRData("pending", confirmationNumber, eventId);

    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .insert({
        vendor_id: vendorId,
        booth_id: boothId,
        event_id: eventId,
        confirmation_number: confirmationNumber,
        status: "pending",
        amount_paid: totalCharged,
        booth_fee: booth.price,
        platform_fee: platformFee,
        stripe_fee: stripeFee,
        stripe_payment_intent_id: paymentIntent.id,
        qr_code_data: qrData,
      })
      .select()
      .single();

    if (bookingError) throw bookingError;

    return res.status(200).json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      bookingId: booking.id,
      confirmationNumber,
      fees: { totalCharged, stripeFee, platformFee, organizerAmount },
    });

  } catch (err) {
    console.error("Create payment intent error:", err);
    return res.status(500).json({ error: "Failed to create payment" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 3 — Confirm booking after successful payment
// POST /api/payments/confirm
// Body: { paymentIntentId, bookingId }
// ─────────────────────────────────────────────────────────────────
app.post("/api/payments/confirm", async (req, res) => {
  const { paymentIntentId, bookingId } = req.body;

  try {
    // 1. Verify payment with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ error: "Payment has not succeeded" });
    }

    // 2. Fetch booking
    const { data: booking, error: bookingFetchError } = await supabase
      .from("bookings")
      .select("*, booths(*), events(*), users!vendor_id(*)")
      .eq("id", bookingId)
      .single();

    if (bookingFetchError || !booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    // 3. Update booking to confirmed
    const { error: bookingUpdateError } = await supabase
      .from("bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId);

    if (bookingUpdateError) throw bookingUpdateError;

    // 4. Mark booth as taken
    const { error: boothUpdateError } = await supabase
      .from("booths")
      .update({ status: "taken", locked_by: null, locked_until: null })
      .eq("id", booking.booth_id);

    if (boothUpdateError) throw boothUpdateError;

    // 5. Create payment ledger record
    const { error: paymentError } = await supabase
      .from("payments")
      .insert({
        booking_id: bookingId,
        stripe_payment_intent_id: paymentIntentId,
        amount_total: booking.amount_paid,
        amount_organizer: booking.amount_paid - booking.platform_fee - booking.stripe_fee,
        amount_platform: booking.platform_fee,
        amount_stripe: booking.stripe_fee,
        currency: "usd",
        status: "succeeded",
        paid_at: new Date().toISOString(),
      });

    if (paymentError) throw paymentError;

    // 6. Send confirmation email to vendor
    await sendVendorConfirmationEmail(booking);

    // 7. Send notification to organizer
    await sendOrganizerNotification(booking);

    return res.status(200).json({
      success: true,
      booking: {
        id: bookingId,
        confirmationNumber: booking.confirmation_number,
        boothNumber: booking.booths.booth_number,
        eventName: booking.events.name,
        amountPaid: booking.amount_paid,
        qrCodeData: booking.qr_code_data,
      },
    });

  } catch (err) {
    console.error("Confirm booking error:", err);
    return res.status(500).json({ error: "Failed to confirm booking" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 4 — Stripe Webhook (payment events from Stripe)
// POST /api/webhooks/stripe
// ─────────────────────────────────────────────────────────────────
app.post("/api/webhooks/stripe", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      // ── Payment succeeded ──
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        const { boothId, vendorId, eventId } = pi.metadata;
        console.log(`✅ Payment succeeded for booth ${boothId} by vendor ${vendorId}`);

        // Update booth status as backup (in case /confirm wasn't called)
        await supabase.from("booths").update({ status: "taken", locked_by: null, locked_until: null }).eq("id", boothId);
        await supabase.from("bookings").update({ status: "confirmed" }).eq("stripe_payment_intent_id", pi.id);

        break;
      }

      // ── Payment failed ──
      case "payment_intent.payment_failed": {
        const pi = event.data.object;
        const { boothId } = pi.metadata;
        console.log(`❌ Payment failed for booth ${boothId}`);

        // Release the booth lock so others can book it
        await supabase.from("booths").update({ status: "available", locked_by: null, locked_until: null }).eq("id", boothId);
        await supabase.from("bookings").update({ status: "cancelled" }).eq("stripe_payment_intent_id", pi.id);

        break;
      }

      // ── Refund issued ──
      case "charge.refunded": {
        const charge = event.data.object;
        console.log(`💸 Refund issued for charge ${charge.id}`);

        await supabase.from("bookings")
          .update({ status: "refunded", refunded_at: new Date().toISOString() })
          .eq("stripe_payment_intent_id", charge.payment_intent);

        // Release the booth back to available
        const { data: booking } = await supabase.from("bookings")
          .select("booth_id").eq("stripe_payment_intent_id", charge.payment_intent).single();

        if (booking) {
          await supabase.from("booths").update({ status: "available" }).eq("id", booking.booth_id);
        }

        break;
      }

      default:
        console.log(`Unhandled Stripe event: ${event.type}`);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 5 — Get booking details
// GET /api/bookings/:id
// ─────────────────────────────────────────────────────────────────
app.get("/api/bookings/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("*, booths(*), events(*), users!vendor_id(*, vendor_profiles(*))")
      .eq("id", id)
      .single();

    if (error || !booking) return res.status(404).json({ error: "Booking not found" });

    return res.status(200).json({ booking });

  } catch (err) {
    console.error("Get booking error:", err);
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 6 — Release expired booth locks (called by cron job)
// POST /api/booths/release-locks
// ─────────────────────────────────────────────────────────────────
app.post("/api/booths/release-locks", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("booths")
      .update({ status: "available", locked_by: null, locked_until: null })
      .eq("status", "locked")
      .lt("locked_until", new Date().toISOString());

    if (error) throw error;

    console.log(`🔓 Released expired locks`);
    return res.status(200).json({ success: true, message: "Expired locks released" });

  } catch (err) {
    console.error("Release locks error:", err);
    return res.status(500).json({ error: "Failed to release locks" });
  }
});

// ─────────────────────────────────────────────────────────────────
// ROUTE 7 — Day-of QR check-in
// POST /api/bookings/checkin
// Body: { qrData, organizerId }
// ─────────────────────────────────────────────────────────────────
app.post("/api/bookings/checkin", async (req, res) => {
  const { qrData, organizerId } = req.body;

  try {
    const parsed = JSON.parse(qrData);
    const { confirmationNumber } = parsed;

    // Fetch booking
    const { data: booking, error } = await supabase
      .from("bookings")
      .select("*, events(*), booths(*), users!vendor_id(*)")
      .eq("confirmation_number", confirmationNumber)
      .single();

    if (error || !booking) {
      return res.status(404).json({ error: "Booking not found", valid: false });
    }

    if (booking.status !== "confirmed") {
      return res.status(400).json({ error: "Booking is not confirmed", valid: false, status: booking.status });
    }

    if (booking.checked_in) {
      return res.status(200).json({
        valid: true,
        alreadyCheckedIn: true,
        message: "Vendor already checked in",
        checkedInAt: booking.checked_in_at,
        booth: booking.booths,
        vendor: booking.users,
      });
    }

    // Mark as checked in
    await supabase.from("bookings").update({ checked_in: true, checked_in_at: new Date().toISOString() }).eq("id", booking.id);

    return res.status(200).json({
      valid: true,
      alreadyCheckedIn: false,
      message: "✅ Vendor checked in successfully",
      booth: { number: booking.booths.booth_number, tier: booking.booths.tier, zone: booking.booths.zone_label },
      vendor: { name: booking.users.full_name, businessName: booking.users.vendor_profiles?.business_name, selling: booking.vendor_notes },
      event: { name: booking.events.name, date: booking.events.date },
    });

  } catch (err) {
    console.error("Check-in error:", err);
    return res.status(500).json({ error: "Check-in failed", valid: false });
  }
});

// ─────────────────────────────────────────────────────────────────
// EMAIL HELPERS
// ─────────────────────────────────────────────────────────────────
async function sendVendorConfirmationEmail(booking) {
  try {
    await resend.emails.send({
      from: "Event Hopper <noreply@eventhopper.com>",
      to: booking.users.email,
      subject: `✅ Booth #${booking.booths.booth_number} Confirmed — ${booking.events.name}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 560px; margin: 0 auto; background: #fff; border: 2px solid #1a1a2e; border-radius: 12px; overflow: hidden;">
          <div style="background: #2E8BC0; padding: 28px 32px;">
            <h1 style="color: #F9D923; margin: 0; font-size: 28px;">🦗 Event Hopper</h1>
            <p style="color: rgba(255,255,255,0.85); margin: 8px 0 0; font-family: 'Courier New', monospace; font-size: 13px;">You're booked!</p>
          </div>
          <div style="padding: 32px;">
            <h2 style="font-size: 22px; color: #1a1a2e; margin: 0 0 6px;">${booking.events.name}</h2>
            <p style="font-family: 'Courier New', monospace; font-size: 12px; color: #6b7280; margin: 0 0 24px;">${booking.events.date} · ${booking.events.start_time} – ${booking.events.end_time}</p>

            <div style="background: #f8f8f8; border-radius: 10px; padding: 18px; margin-bottom: 20px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span style="font-family: 'Courier New', monospace; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Confirmation</span>
                <span style="font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #1a1a2e;">${booking.confirmation_number}</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span style="font-family: 'Courier New', monospace; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Booth</span>
                <span style="font-family: 'Courier New', monospace; font-size: 12px; font-weight: 700; color: #1a1a2e;">#${booking.booths.booth_number} · ${booking.booths.tier} · 10×10 ft</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span style="font-family: 'Courier New', monospace; font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 1px;">Amount Paid</span>
                <span style="font-family: 'Courier New', monospace; font-size: 14px; font-weight: 800; color: #27ae60;">$${booking.amount_paid.toFixed(2)}</span>
              </div>
            </div>

            <div style="border-top: 1px solid rgba(0,0,0,0.08); padding-top: 20px;">
              <p style="font-family: 'Courier New', monospace; font-size: 12px; color: #555; margin: 0 0 6px;">📍 ${booking.events.address}</p>
              <p style="font-family: 'Courier New', monospace; font-size: 12px; color: #555; margin: 0;">Show your QR code at check-in on the day of the event.</p>
            </div>
          </div>
        </div>
      `,
    });
    console.log(`📧 Confirmation email sent to ${booking.users.email}`);
  } catch (err) {
    console.error("Email send error:", err);
  }
}

async function sendOrganizerNotification(booking) {
  try {
    // Get organizer email
    const { data: organizer } = await supabase
      .from("users")
      .select("email, full_name")
      .eq("id", booking.events.organizer_id)
      .single();

    if (!organizer) return;

    await resend.emails.send({
      from: "Event Hopper <noreply@eventhopper.com>",
      to: organizer.email,
      subject: `🎉 New Booking — Booth #${booking.booths.booth_number} · ${booking.events.name}`,
      html: `
        <div style="font-family: Georgia, serif; max-width: 520px; margin: 0 auto;">
          <div style="background: #F9D923; padding: 20px 28px; border-radius: 12px 12px 0 0; border: 2px solid #1a1a2e;">
            <h2 style="margin: 0; color: #1a1a2e;">🎉 New Booth Booked!</h2>
          </div>
          <div style="background: #fff; padding: 24px 28px; border: 2px solid #1a1a2e; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="font-family: 'Courier New', monospace; font-size: 13px; color: #333;">
              <strong>${booking.users.full_name}</strong> just booked <strong>Booth #${booking.booths.booth_number}</strong> for <strong>${booking.events.name}</strong>.
            </p>
            <div style="background: #f0fff4; border: 1px solid #27ae60; border-radius: 8px; padding: 14px; margin-top: 14px;">
              <p style="font-family: 'Courier New', monospace; font-size: 12px; color: #27ae60; margin: 0; font-weight: 700;">
                💰 $${(booking.amount_paid - booking.platform_fee - booking.stripe_fee).toFixed(2)} will be deposited to your account.
              </p>
            </div>
          </div>
        </div>
      `,
    });
    console.log(`📧 Organizer notification sent to ${organizer.email}`);
  } catch (err) {
    console.error("Organizer notification error:", err);
  }
}

// ─────────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🦗 Event Hopper API running on port ${PORT}`);
  console.log(`   Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE 🔴" : "TEST 🟡"}`);
});

export default app;
