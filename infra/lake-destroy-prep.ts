// Temporary destroy prep: keep only non-empty resources declared so SST updates forceDestroy before omission.
new aws.s3tables.TableBucket("LakeTableBucket", {
  name: `opencode-${$app.stage}-lake`,
  forceDestroy: true,
})

const athenaResultsBucket = new aws.s3.Bucket("LakeAthenaResults", {
  bucket: `opencode-${$app.stage}-lake-athena-results`,
  forceDestroy: true,
})

new aws.s3.Bucket("LakeFirehoseErrors", {
  bucket: `opencode-${$app.stage}-lake-firehose-errors`,
  forceDestroy: true,
})

new aws.athena.Workgroup("LakeAthenaWorkgroup", {
  name: `opencode-${$app.stage}-lake-workgroup`,
  forceDestroy: true,
  configuration: {
    enforceWorkgroupConfiguration: true,
    publishCloudwatchMetricsEnabled: true,
    resultConfiguration: {
      outputLocation: $interpolate`s3://${athenaResultsBucket.bucket}/`,
    },
  },
})
