// Compile-time bridge. OSS resolves this to the no-op module; Enterprise builds
// resolve it to the private sibling repository.
export {
  getBinding,
  isEnterprise,
  useEnterpriseStore,
} from '@enterprise-modules'
