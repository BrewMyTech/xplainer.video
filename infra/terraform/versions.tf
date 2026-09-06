# Terraform and provider pins.
#
# The Cloudflare pin is `~> 5.24`, and the major matters more than the minor.
# The provider moved and renamed resources across its v4 -> v5 rewrite: the DNS
# resource this module uses is `cloudflare_dns_record` in v5 and was
# `cloudflare_record` in v4, and R2 resources moved with it. The constraint was
# chosen by installing the provider and reading its schema rather than from
# memory:
#
#     terraform providers schema -json
#
# against cloudflare/cloudflare v5.24.0 lists `cloudflare_r2_bucket` and
# `cloudflare_dns_record` as resources, which is what this module declares. The
# `~> 5.24` form admits 5.x minor and patch upgrades and refuses 6.0, where the
# next rename would otherwise land silently.
terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }
}
