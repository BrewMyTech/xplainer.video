# The provider is configured from input variables and nothing else.
#
# No credential is hard-coded, defaulted or read from a file in the repository.
# That is what lets `terraform init -backend=false && terraform validate` run
# with an empty environment: validation never resolves a provider credential,
# and an `apply` gets its token from a tfvars file or from
# TF_VAR_cloudflare_api_token, neither of which is committed.

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
