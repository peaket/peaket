locals {
  edge = jsondecode(file("${path.module}/edge-plan.json"))
}

resource "aws_cloudfront_cache_policy" "screen_html" {
  name        = "screen-html"
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 300
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "no_store" {
  name        = "no-store"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "static" {
  name        = "static"
  min_ttl     = 86400
  default_ttl = 2592000
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "search_api" {
  name        = "search-api"
  min_ttl     = 0
  default_ttl = 60
  max_ttl     = 300
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config {
      query_string_behavior = "whitelist"
      query_strings { items = ["q", "page", "limit"] }
    }
  }
}

resource "aws_cloudfront_cache_policy" "shuffle_proof" {
  name        = "shuffle-proof"
  min_ttl     = 0
  default_ttl = 5
  max_ttl     = 5
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "screen" {
  name = "screen"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    content_security_policy {
      content_security_policy = "default-src 'none'; frame-ancestors 'none'"
      override                = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "screen_app_csp" {
  name = "screen-app-csp"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "console_app_csp" {
  name = "console-app-csp"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "scanner_app_csp" {
  name = "scanner-app-csp"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "api" {
  name = "api"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    content_security_policy {
      content_security_policy = "default-src 'none'; frame-ancestors 'none'"
      override                = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "queue_result" {
  name = "queue-result"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
    content_type_options {
      override = true
    }
    content_security_policy {
      content_security_policy = "default-src 'none'; frame-ancestors 'none'"
      override                = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_origins { items = ["https://www.peaket.example"] }
  }
}

resource "aws_wafv2_web_acl" "queue_api" {
  name  = "queue-api"
  scope = "CLOUDFRONT"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "queue-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl" "screen_partner_console" {
  name  = "screen-partner-console"
  scope = "CLOUDFRONT"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "screen-partner-console"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl" "api" {
  name  = "api"
  scope = "CLOUDFRONT"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "api"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_distribution" "www" {
  comment = "PEAKET www (F-09-4)"
  enabled = true
  aliases = ["www.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "www-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "www-origin"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.screen_html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.screen_app_csp.id
  }
  web_acl_id = aws_wafv2_web_acl.screen_partner_console.arn
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "queue" {
  comment = "PEAKET queue (F-09-4)"
  enabled = true
  aliases = ["queue.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "queue-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "queue-origin"
    viewer_protocol_policy     = "https-only"
    cache_policy_id            = aws_cloudfront_cache_policy.no_store.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
  }
  web_acl_id = aws_wafv2_web_acl.queue_api.arn
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "queue_files" {
  comment = "PEAKET queue-files (F-09-4)"
  enabled = true
  aliases = ["queue-files.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "queue-files-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "queue-files-origin"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.static.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.queue_result.id
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "api" {
  comment = "PEAKET api (F-09-4)"
  enabled = true
  aliases = ["api.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "api-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "api-origin"
    viewer_protocol_policy     = "https-only"
    cache_policy_id            = aws_cloudfront_cache_policy.search_api.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
  }
  web_acl_id = aws_wafv2_web_acl.api.arn
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "partner" {
  comment = "PEAKET partner (F-09-4)"
  enabled = true
  aliases = ["partner.peaket.example", "partner-api.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "partner-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "partner-origin"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.screen_html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.screen_app_csp.id
  }
  web_acl_id = aws_wafv2_web_acl.screen_partner_console.arn
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "console" {
  comment = "PEAKET console (F-09-4)"
  enabled = true
  aliases = ["console.peaket.example", "ops-api.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "console-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "console-origin"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.screen_html.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.console_app_csp.id
  }
  web_acl_id = aws_wafv2_web_acl.screen_partner_console.arn
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "scanner" {
  comment = "PEAKET scanner (F-09-4)"
  enabled = true
  aliases = ["scanner.peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "scanner-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "scanner-origin"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.static.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.scanner_app_csp.id
  }
  web_acl_id = aws_wafv2_web_acl.screen_partner_console.arn
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

resource "aws_cloudfront_distribution" "developers" {
  comment = "PEAKET developers (F-09-4)"
  enabled = true
  aliases = ["developers.peaket.example", "peaket.example"]
  origin {
    domain_name = "origin.peaket.example"
    origin_id   = "developers-origin"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }
  default_cache_behavior {
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    target_origin_id           = "developers-origin"
    viewer_protocol_policy     = "redirect-to-https"
    cache_policy_id            = aws_cloudfront_cache_policy.static.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.api.id
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = true
  }
  minimum_protocol_version = "TLSv1.2_2021"
}

