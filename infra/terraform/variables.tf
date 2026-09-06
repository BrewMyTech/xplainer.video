# Inputs. The token carries no default and is marked sensitive; everything else
# carries a working default, so `terraform plan` needs only the token and an
# account id.

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:DNS:Edit on the zone and Workers R2 Storage:Edit on the account. Supply via TF_VAR_cloudflare_api_token or a local, untracked tfvars file."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the R2 bucket. An identifier, not a credential, so it is not marked sensitive; it appears in the R2 S3 endpoint hostname the cdn record points at."
  type        = string
}

variable "zone_name" {
  description = "The Cloudflare zone the cdn DNS record is created in, e.g. xplainer.video. The zone id is looked up from this name so the module needs one fewer opaque identifier."
  type        = string
  default     = "xplainer.video"
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket that holds release artefacts: CLI and desktop builds, the per-OS TTS bundles `xplainer setup` downloads on first run, and the version/checksum manifest naming them. Also forms the origin hostname the cdn DNS record points at."
  type        = string
  default     = "xplainer-artifacts"
}
