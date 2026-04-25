import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Supabase ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Stripe (graceful if missing) ────────────────────────────────────────────
let stripe = null;
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'placeholder') {
  const Stripe = (await import('stripe')).default;
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  console.log('✅ Stripe initialized');
} else {
  console.log('⚠️  Stripe key not configured — payment endpoints will mock');
}

// ─── Resend (graceful if missing) ────────────────────────────────────────────
let resend = null;
if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 'placeholder') {
  const { Resend } = await import('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
  console.log('✅ Resend initialized');
} else {
  console.log('⚠️  Resend key not configured — emails will be skipped');
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://event-hopper-7.vercel.app',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
  ],
  credentials: true,
}));
app.use(express.json());

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — ORGANIZER SIGNUP (with password hashing)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/organizer-signup', async (req, res) => {
  try {
    const {
      email, password, full_name,
      business_name, phone, website, event_types, description,
    } = req.body;

    if (!email || !password || !full_name || !business_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check for existing user
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Create user row
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        email: email.toLowerCase().trim(),
        password_hash,
        full_name,
        role: 'organizer',
        is_active: true, // auto-approved for MVP
      })
      .select()
      .single();

    if (userError) throw userError;

    // Create organizer profile
    const { error: profileError } = await supabase
      .from('organizer_profiles')
      .insert({
        user_id: newUser.id,
        business_name,
        phone: phone || null,
        website: website || null,
        event_types: event_types || null,
        description: description || null,
        approval_status: 'approved',  // auto-approve for MVP
      });

    if (profileError) throw profileError;

    // Notify Event Hopper team via email (if Resend configured)
    if (resend) {
      await resend.emails.send({
        from: 'Event Hopper <noreply@eventhopper.com>',
        to: 'team@eventhopper.com', // update to real team email
        subject: `New organizer signup: ${business_name}`,
        html: `
          <h2>New Organizer Signup</h2>
          <p><strong>Name:</strong> ${full_name}</p>
          <p><strong>Business:</strong> ${business_name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Phone:</strong> ${phone || 'N/A'}</p>
          <p><strong>Website:</strong> ${website || 'N/A'}</p>
          <p><strong>Event Types:</strong> ${event_types || 'N/A'}</p>
          <p><strong>Description:</strong> ${description || 'N/A'}</p>
          <p><a href="https://event-hopper-7.vercel.app/admin">Go to Admin Portal to approve →</a></p>
        `,
      }).catch(e => console.error('Email send error:', e));
    }

    res.json({ success: true, message: 'Application received! We\'ll review and reach out within 24 hours.' });
  } catch (err) {
    console.error('Organizer signup error:', err);
    res.status(500).json({ error: err.message || 'Signup failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — ORGANIZER LOGIN (with bcrypt password verification)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/organizer-login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Fetch user + organizer profile
    const { data: user, error: userError } = await supabase
      .from('users')
      .select(`
        id, email, full_name, role, is_active, password_hash,
        organizer_profiles (
          id, business_name, approval_status, phone, website, event_types, description
        )
      `)
      .eq('email', email.toLowerCase().trim())
      .eq('role', 'organizer')
      .single();

    if (userError || !user) {
      return res.status(401).json({ error: 'No organizer account found with that email.' });
    }

    // Verify password
    if (!user.password_hash) {
      // Legacy: account created before password hashing — force reset
      return res.status(401).json({ error: 'Please reset your password. Contact support@eventhopper.com' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }

    // Check approval — skip pending check since all new accounts are auto-approved
    const profile = user.organizer_profiles?.[0];
    if (!profile) {
      return res.status(403).json({ error: 'Organizer profile not found. Contact support.' });
    }

    if (profile.approval_status === 'rejected') {
      return res.status(403).json({
        error: 'Your application was not approved. Contact support@eventhopper.com for more info.',
        approval_status: 'rejected',
      });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is inactive. Contact support.' });
    }

    // Return safe user object (no password hash)
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        organizer_profile: profile,
      },
    });
  } catch (err) {
    console.error('Organizer login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — GET PENDING ORGANIZERS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/organizers', async (req, res) => {
  try {
    const { status } = req.query; // 'pending' | 'approved' | 'rejected' | 'all'

    let query = supabase
      .from('organizer_profiles')
      .select(`
        id, business_name, phone, website, event_types, description, approval_status, created_at,
        users!organizer_profiles_user_id_fkey ( id, email, full_name, is_active, created_at )
      `)
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      query = query.eq('approval_status', status);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ organizers: data });
  } catch (err) {
    console.error('Get organizers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — APPROVE / REJECT ORGANIZER
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/organizers/:userId/approve', async (req, res) => {
  try {
    const { userId } = req.params;
    const { action, note } = req.body; // action: 'approve' | 'reject'

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be approve or reject' });
    }

    const approval_status = action === 'approve' ? 'approved' : 'rejected';
    const is_active = action === 'approve';

    // Update organizer_profiles
    const { error: profileError } = await supabase
      .from('organizer_profiles')
      .update({ approval_status })
      .eq('user_id', userId);

    if (profileError) throw profileError;

    // Update users table
    const { error: userError } = await supabase
      .from('users')
      .update({ is_active })
      .eq('id', userId);

    if (userError) throw userError;

    // Send email to organizer (if Resend configured)
    if (resend) {
      const { data: userData } = await supabase
        .from('users')
        .select('email, full_name, organizer_profiles(business_name)')
        .eq('id', userId)
        .single();

      if (userData) {
        const subject = action === 'approve'
          ? `You're approved! Welcome to Event Hopper 🦗`
          : `Event Hopper Application Update`;

        const html = action === 'approve'
          ? `
            <h2>You're approved, ${userData.full_name}!</h2>
            <p>Your Event Hopper organizer account is ready. You can now log in and start creating events.</p>
            <p><a href="https://event-hopper-7.vercel.app">Log in to Event Hopper →</a></p>
          `
          : `
            <h2>Application Update</h2>
            <p>Hi ${userData.full_name}, unfortunately we're not able to approve your application at this time.</p>
            ${note ? `<p>Note: ${note}</p>` : ''}
            <p>Questions? Reply to this email or contact support@eventhopper.com</p>
          `;

        await resend.emails.send({
          from: 'Event Hopper <noreply@eventhopper.com>',
          to: userData.email,
          subject,
          html,
        }).catch(e => console.error('Email send error:', e));
      }
    }

    res.json({ success: true, action, userId });
  } catch (err) {
    console.error('Organizer approval error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORGANIZER — CREATE EVENT (tied to organizer_id)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/events/create', async (req, res) => {
  try {
    const {
      organizer_user_id,
      name, description, date, end_date,
      location, address, city, state,
      event_type, expected_vendors,
      is_recurring, recurrence_type, recurrence_count,
      image_url,
    } = req.body;

    if (!organizer_user_id || !name || !date) {
      return res.status(400).json({ error: 'Missing required fields: organizer_user_id, name, date' });
    }

    // Verify organizer is approved
    const { data: profile, error: profileError } = await supabase
      .from('organizer_profiles')
      .select('id, business_name, approval_status')
      .eq('user_id', organizer_user_id)
      .single();

    if (profileError || !profile) {
      return res.status(403).json({ error: 'Organizer profile not found' });
    }

    if (profile.approval_status !== 'approved') {
      return res.status(403).json({ error: 'Organizer not approved' });
    }

    const eventsToCreate = [];

    if (is_recurring && recurrence_type && recurrence_count > 1) {
      // Create multiple dated events
      const baseDate = new Date(date);
      const intervalDays = recurrence_type === 'weekly' ? 7 : 14;

      for (let i = 0; i < recurrence_count; i++) {
        const eventDate = new Date(baseDate);
        eventDate.setDate(baseDate.getDate() + i * intervalDays);

        eventsToCreate.push({
          organizer_id: organizer_user_id,
          name: `${name}${i > 0 ? ` (${eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})` : ''}`,
          description: description || null,
          date: eventDate.toISOString().split('T')[0],
          end_date: end_date || null,
          location: location || null,
          address: address || null,
          city: city || null,
          state: state || null,
          event_type: event_type || 'flea_market',
          expected_vendors: expected_vendors || null,
          image_url: image_url || null,
          status: 'draft',
          recurrence_group: `${organizer_user_id}-${Date.now()}`,
        });
      }
    } else {
      eventsToCreate.push({
        organizer_id: organizer_user_id,
        name,
        description: description || null,
        date,
        end_date: end_date || null,
        location: location || null,
        address: address || null,
        city: city || null,
        state: state || null,
        event_type: event_type || 'flea_market',
        expected_vendors: expected_vendors || null,
        image_url: image_url || null,
        status: 'draft',
      });
    }

    const { data: createdEvents, error: eventError } = await supabase
      .from('events')
      .insert(eventsToCreate)
      .select();

    if (eventError) throw eventError;

    res.json({ success: true, events: createdEvents });
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORGANIZER — GET MY EVENTS (with booth counts)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/events/organizer/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const { data: events, error } = await supabase
      .from('events')
      .select(`
        id, name, date, status, event_type, location, address, city, state, description,
        created_at,
        booths ( id, status, tier, price )
      `)
      .eq('organizer_id', userId)
      .order('date', { ascending: true });

    if (error) throw error;

    // Enrich with booth stats
    const enriched = events.map(event => ({
      ...event,
      booth_count: event.booths?.length || 0,
      booths_available: event.booths?.filter(b => b.status === 'available').length || 0,
      booths_taken: event.booths?.filter(b => b.status === 'taken').length || 0,
    }));

    res.json({ events: enriched });
  } catch (err) {
    console.error('Get organizer events error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENTS — Create booking + Stripe PaymentIntent
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/payments/create-intent', async (req, res) => {
  try {
    const { booth_id, vendor_info, event_id } = req.body;

    // Verify booth is available
    const { data: booth, error: boothError } = await supabase
      .from('booths')
      .select('id, price, status, tier, event_id')
      .eq('id', booth_id)
      .single();

    if (boothError || !booth) {
      return res.status(404).json({ error: 'Booth not found' });
    }

    if (booth.status === 'taken') {
      return res.status(409).json({ error: 'This booth was just booked by someone else. Please choose another.' });
    }

    const amount = Math.round((booth.price || 45) * 100); // cents
    const platformFeePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT || '5') / 100;
    const platformFee = Math.round(amount * platformFeePercent);

    // Upsert vendor in users table
    let vendorId;
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', vendor_info.email.toLowerCase().trim())
      .maybeSingle();

    if (existingUser) {
      vendorId = existingUser.id;
    } else {
      const { data: newVendor, error: vendorError } = await supabase
        .from('users')
        .insert({
          email: vendor_info.email.toLowerCase().trim(),
          full_name: vendor_info.name,
          role: 'vendor',
          is_active: true,
        })
        .select()
        .single();

      if (vendorError) throw vendorError;
      vendorId = newVendor.id;
    }

    // Upsert vendor_profile
    await supabase
      .from('vendor_profiles')
      .upsert({
        user_id: vendorId,
        business_name: vendor_info.business_name || vendor_info.name,
        phone: vendor_info.phone || null,
        what_selling: vendor_info.what_selling || null,
      }, { onConflict: 'user_id' });

    // Generate confirmation number
    const confirmationNumber = `EH-${Math.random().toString(36).substring(2, 7).toUpperCase()}-${Math.floor(Math.random() * 9000 + 1000)}`;

    // Create booking
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .insert({
        vendor_id: vendorId,
        booth_id,
        event_id: event_id || booth.event_id,
        status: 'confirmed',
        amount_paid: booth.price,
        platform_fee: platformFee / 100,
        confirmation_number: confirmationNumber,
        vendor_name: vendor_info.name,
        vendor_email: vendor_info.email,
        vendor_phone: vendor_info.phone || null,
        business_name: vendor_info.business_name || null,
        what_selling: vendor_info.what_selling || null,
      })
      .select()
      .single();

    if (bookingError) throw bookingError;

    // Mark booth as taken
    await supabase
      .from('booths')
      .update({ status: 'taken' })
      .eq('id', booth_id);

    // Create Stripe PaymentIntent (if configured)
    let clientSecret = null;
    if (stripe) {
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        metadata: {
          booking_id: booking.id,
          confirmation_number: confirmationNumber,
          vendor_email: vendor_info.email,
          booth_id,
          event_id: event_id || booth.event_id,
          platform_fee: platformFee,
        },
      });
      clientSecret = paymentIntent.client_secret;

      // Record in payments table
      await supabase.from('payments').insert({
        booking_id: booking.id,
        stripe_payment_intent_id: paymentIntent.id,
        amount: booth.price,
        platform_fee: platformFee / 100,
        status: 'pending',
      });
    }

    // Send vendor confirmation email (if Resend configured)
    if (resend) {
      await resend.emails.send({
        from: 'Event Hopper <noreply@eventhopper.com>',
        to: vendor_info.email,
        subject: `Booking Confirmed! ${confirmationNumber}`,
        html: `
          <h2>You're booked! 🎉</h2>
          <p>Hi ${vendor_info.name},</p>
          <p>Your booth has been confirmed.</p>
          <p><strong>Confirmation #:</strong> ${confirmationNumber}</p>
          <p><strong>Amount:</strong> $${booth.price}</p>
          <p>See you at the market!</p>
          <p>— The Event Hopper Team</p>
        `,
      }).catch(e => console.error('Email error:', e));
    }

    res.json({
      success: true,
      clientSecret,
      confirmationNumber,
      booking,
    });
  } catch (err) {
    console.error('Payment error:', err);
    res.status(500).json({ error: err.message || 'Booking failed' });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🦗 Event Hopper backend running on port ${PORT}`);
});
