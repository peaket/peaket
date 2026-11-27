locals {
  iam = jsondecode(file("${path.module}/iam-plan.json"))
}

resource "aws_iam_role" "purchase_svc_pod_identity" {
  name = "peaket-purchase-svc"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "purchase_svc_msk" {
  name = "peaket-purchase-svc-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-purchase-svc" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "purchase_svc_msk" {
  name = "peaket-purchase-svc-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:WriteData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/trade-control/*/trade.orders"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/trade-control/*/purchase-svc"]
      },
    ]
  })
}

resource "aws_iam_role" "core_svc_pod_identity" {
  name = "peaket-core-svc"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "core_svc_msk" {
  name = "peaket-core-svc-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-core-svc" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "core_svc_msk" {
  name = "peaket-core-svc-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/trade-control/*/trade.orders"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/trade-control/*/core-svc"]
      },
    ]
  })
}

resource "aws_iam_role" "ops_svc_pod_identity" {
  name = "peaket-ops-svc"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "ops_svc_msk" {
  name = "peaket-ops-svc-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-ops-svc" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "ops_svc_msk" {
  name = "peaket-ops-svc-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/control/*/control.settings"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/control/*/ops-svc"]
      },
    ]
  })
}

resource "aws_iam_role" "queue_svc_pod_identity" {
  name = "peaket-queue-svc"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "queue_svc_msk" {
  name = "peaket-queue-svc-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-queue-svc" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "queue_svc_msk" {
  name = "peaket-queue-svc-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:WriteData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/telemetry/*/telemetry.queue"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/telemetry/*/queue-svc"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:WriteData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/trade-control/*/support.cases-requested"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/trade-control/*/queue-svc-support"]
      },
    ]
  })
}

resource "aws_iam_role" "trust_svc_pod_identity" {
  name = "peaket-trust-svc"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "trust_svc_msk" {
  name = "peaket-trust-svc-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-trust-svc" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "trust_svc_msk" {
  name = "peaket-trust-svc-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:WriteData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/telemetry/*/telemetry.verdicts"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/telemetry/*/trust-svc"]
      },
    ]
  })
}

resource "aws_iam_role" "payment_svc_pod_identity" {
  name = "peaket-payment-svc"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "payment_svc_msk" {
  name = "peaket-payment-svc-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-payment-svc" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "payment_svc_msk" {
  name = "peaket-payment-svc-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/trade-control/*/trade.orders"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/trade-control/*/payment-svc"]
      },
    ]
  })
}

resource "aws_iam_role" "realtime_gw_pod_identity" {
  name = "peaket-realtime-gw"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "pods.eks.amazonaws.com" }
      Action    = ["sts:AssumeRole", "sts:TagSession"]
    }]
  })
}

resource "aws_iam_role" "realtime_gw_msk" {
  name = "peaket-realtime-gw-msk"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.account_id}:role/peaket-realtime-gw" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_policy" "realtime_gw_msk" {
  name = "peaket-realtime-gw-msk-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeTopic", "kafka-cluster:Connect"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:topic/trade-control/*/trade.seats"]
      },
      {
        Effect   = "Allow"
        Action   = ["kafka-cluster:ReadData", "kafka-cluster:DescribeGroup", "kafka-cluster:Connect", "kafka-cluster:AlterGroup"]
        Resource = ["arn:aws:kafka:${var.region}:${var.account_id}:group/trade-control/*/realtime-gw"]
      },
    ]
  })
}

