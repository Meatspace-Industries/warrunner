interface EnvironmentVariables {
  readonly PORT: string
  readonly ENVIRONMENT: 'development' | 'production' | 'test'
  readonly COMMIT_SHA: string
}

declare namespace NodeJS {
  interface ProcessEnv extends EnvironmentVariables {
    readonly NODE_ENV: EnvironmentVariables['ENVIRONMENT']
  }
}

declare namespace Bun {
  interface Env extends EnvironmentVariables {
    readonly NODE_ENV: EnvironmentVariables['ENVIRONMENT']
  }
}
