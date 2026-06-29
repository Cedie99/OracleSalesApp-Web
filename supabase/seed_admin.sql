-- Seed: Initial Admin Account
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor)
-- Change the email and password below before running if desired.

DO $$
DECLARE
  v_user_id UUID;
  v_email   TEXT := 'admin@salesadmin.local';
  v_pass    TEXT := 'Admin@2025!';
  v_name    TEXT := 'System Admin';
BEGIN
  -- Require pgcrypto for password hashing
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  -- Skip if the auth user already exists
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_email) THEN
    RAISE NOTICE 'Admin user already exists, skipping.';
    RETURN;
  END IF;

  -- Insert into Supabase auth.users
  INSERT INTO auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated',
    'authenticated',
    v_email,
    crypt(v_pass, gen_salt('bf')),
    NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', v_name),
    NOW(),
    NOW(),
    '', '', '', ''
  )
  RETURNING id INTO v_user_id;

  -- Create the matching profile with admin role
  INSERT INTO profiles (user_id, full_name, role)
  VALUES (v_user_id, v_name, 'admin');

  RAISE NOTICE 'Admin account created — email: %, password: %', v_email, v_pass;
END $$;
