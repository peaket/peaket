locals {
  keys = jsondecode(file("${path.module}/key-plan.json"))
}

resource "aws_kms_key" "admin_totp" {
  description             = "PEAKET admin-totp (F-09-4)"
  key_spec                = "SYMMETRIC_DEFAULT"
  key_usage               = "ENCRYPT_DECRYPT"
  multi_region            = true
  deletion_window_in_days = 30
  enable_key_rotation     = true
  rotation_period_in_days = 365
}

resource "aws_kms_alias" "admin_totp_alias" {
  name          = "alias/peaket-admin-totp"
  target_key_id = aws_kms_key.admin_totp.key_id
}

resource "aws_kms_key" "virtual_account" {
  description             = "PEAKET virtual-account (F-09-4)"
  key_spec                = "SYMMETRIC_DEFAULT"
  key_usage               = "ENCRYPT_DECRYPT"
  multi_region            = true
  deletion_window_in_days = 30
  enable_key_rotation     = true
  rotation_period_in_days = 365
}

resource "aws_kms_alias" "virtual_account_alias" {
  name          = "alias/peaket-virtual-account"
  target_key_id = aws_kms_key.virtual_account.key_id
}

resource "aws_kms_key" "admin_password_pepper" {
  description             = "PEAKET admin-password-pepper (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "admin_password_pepper_alias" {
  name          = "alias/peaket-admin-password-pepper"
  target_key_id = aws_kms_key.admin_password_pepper.key_id
}

resource "aws_kms_key" "ci_hmac" {
  description             = "PEAKET ci-hmac (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "ci_hmac_alias" {
  name          = "alias/peaket-ci-hmac"
  target_key_id = aws_kms_key.ci_hmac.key_id
}

resource "aws_kms_key" "pid_hmac" {
  description             = "PEAKET pid-hmac (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "pid_hmac_alias" {
  name          = "alias/peaket-pid-hmac"
  target_key_id = aws_kms_key.pid_hmac.key_id
}

resource "aws_kms_key" "analytics_pseudonym" {
  description             = "PEAKET analytics-pseudonym (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = false
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "analytics_pseudonym_alias" {
  name          = "alias/peaket-analytics-pseudonym"
  target_key_id = aws_kms_key.analytics_pseudonym.key_id
}

resource "aws_kms_key" "inv_ref_key_device" {
  description             = "PEAKET inv-ref-key-device (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "inv_ref_key_device_alias" {
  name          = "alias/peaket-inv-ref-key-device"
  target_key_id = aws_kms_key.inv_ref_key_device.key_id
}

resource "aws_kms_key" "inv_ref_key_contact" {
  description             = "PEAKET inv-ref-key-contact (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "inv_ref_key_contact_alias" {
  name          = "alias/peaket-inv-ref-key-contact"
  target_key_id = aws_kms_key.inv_ref_key_contact.key_id
}

resource "aws_kms_key" "inv_ref_key_pay" {
  description             = "PEAKET inv-ref-key-pay (F-09-4)"
  key_spec                = "HMAC_256"
  key_usage               = "GENERATE_VERIFY_MAC"
  multi_region            = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "inv_ref_key_pay_alias" {
  name          = "alias/peaket-inv-ref-key-pay"
  target_key_id = aws_kms_key.inv_ref_key_pay.key_id
}

resource "aws_kms_key" "shuffle_seed" {
  description             = "PEAKET shuffle-seed (F-09-4)"
  key_spec                = "SYMMETRIC_DEFAULT"
  key_usage               = "ENCRYPT_DECRYPT"
  multi_region            = false
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "shuffle_seed_alias" {
  name          = "alias/peaket-shuffle-seed"
  target_key_id = aws_kms_key.shuffle_seed.key_id
}

