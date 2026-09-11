output "r2_bucket_name" {
  description = "Name of the R2 bucket holding release artefacts and the version/checksum manifest."
  value       = cloudflare_r2_bucket.artifacts.name
}

output "cdn_hostname" {
  description = "Hostname release artefacts are served from. The base URL an update feed or a first-run download uses is https://<this>/, and it is cached only once the Cache Rule this module also declares is in place."
  value       = cloudflare_r2_custom_domain.cdn.domain
}
