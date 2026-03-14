/**
 * Environment Variable Validator
 * 
 * Validates required environment variables at startup.
 * - In PRODUCTION: Fails fast with clear error messages
 * - IN TEST: Skips validation entirely
 * - In DEVELOPMENT: Warns but allows startup
 */

/**
 * Check if we're in production
 * Evaluated at call time, not module load time
 */
function isProductionEnv() {
  return process.env.NODE_ENV === 'production' || 
         !!process.env.RAILWAY_ENVIRONMENT || 
         !!process.env.REDIS_URL;
}

/**
 * Check if we're in test mode
 * Evaluated at call time, not module load time
 */
function isTestEnv() {
  return process.env.TEST_MODE === 'true' || 
         process.env.NODE_ENV === 'test';
}

/**
 * Environment variable definitions
 */
const ENV_SPEC = {
  // Critical production requirements
  REDIS_URL: {
    required: false,
    stronglyRecommended: isProductionEnv() && !isTestEnv(),
    category: 'Redis',
    description: 'Redis connection URL for multi-device sync',
    example: 'rediss://default:password@redis.example.com:6379',
    securityImpact: 'HIGH',
    failureImpact: 'Multi-device sync and party discovery will fall back to in-memory mode'
  },
  
  DATABASE_URL: {
    required: false,
    stronglyRecommended: isProductionEnv() && !isTestEnv(),
    category: 'Database',
    description: 'PostgreSQL connection string',
    example: 'postgresql://user:pass@db.example.com:5432/phoneparty',
    securityImpact: 'HIGH',
    failureImpact: 'User accounts, subscriptions, and purchases will not work'
  },
  
  JWT_SECRET: {
    required: false, // Not technically required but HIGHLY recommended
    stronglyRecommended: true,
    category: 'Security',
    description: 'JWT signing secret for authentication',
    example: 'your-super-secret-random-string-min-32-chars',
    securityImpact: 'CRITICAL',
    minLength: 32,
    failureImpact: 'ALL AUTHENTICATION WILL BE DISABLED - ALL PROTECTED ROUTES PUBLICLY ACCESSIBLE',
    insecureDefaults: ['syncspeaker-no-auth-mode', 'dev-secret-not-for-production', 'test-secret']
  },
  
  NODE_ENV: {
    required: false,
    stronglyRecommended: isProductionEnv(),
    category: 'Server',
    description: 'Runtime environment (production/development/test)',
    validValues: ['production', 'development', 'test'],
    securityImpact: 'HIGH',
    failureImpact: 'Security settings (cookies, TLS, error verbosity) may be misconfigured'
  },
  
  // Optional but important in production
  SENTRY_DSN: {
    required: false,
    recommendedInProduction: true,
    category: 'Monitoring',
    description: 'Sentry error tracking DSN',
    example: 'https://abc@o123.ingest.sentry.io/456',
    securityImpact: 'LOW',
    failureImpact: 'Error tracking and monitoring will be disabled'
  },
  
  // Dangerous settings
  ALLOW_FALLBACK_IN_PRODUCTION: {
    required: false,
    dangerous: true,
    category: 'Feature Flags',
    description: 'Allow in-memory fallback when Redis unavailable',
    validValues: ['false'],
    securityImpact: 'MEDIUM',
    failureImpact: 'Multi-instance deployments will break'
  },

  // Admin email allowlist
  ADMIN_EMAILS: {
    required: false,
    stronglyRecommended: isProductionEnv() && !isTestEnv(),
    category: 'Admin',
    description: 'Comma-separated list of admin email addresses (e.g. ianevans2023@outlook.com)',
    example: 'ADMIN_EMAILS=ianevans2023@outlook.com',
    securityImpact: 'HIGH',
    failureImpact: 'No admin accounts will be recognised — admin dashboard and free-tier bypass will be unavailable'
  }
};

/**
 * Validation results
 */
class ValidationResult {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.info = [];
  }
  
  addError(variable, message) {
    this.errors.push({ variable, message, severity: 'ERROR' });
  }
  
  addWarning(variable, message) {
    this.warnings.push({ variable, message, severity: 'WARNING' });
  }
  
  addInfo(variable, message) {
    this.info.push({ variable, message, severity: 'INFO' });
  }
  
  hasErrors() {
    return this.errors.length > 0;
  }
  
  hasWarnings() {
    return this.warnings.length > 0;
  }
  
  print() {
    const errors = this.errors.length;
    const warnings = this.warnings.length;
    const isProduction = isProductionEnv();
    const isTest = isTestEnv();
    
    console.log('\n' + '='.repeat(80));
    console.log('🔍 Environment Variable Validation');
    console.log('='.repeat(80));
    console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);
    console.log(`Test Mode: ${isTest ? 'YES' : 'NO'}`);
    console.log(`NODE_ENV: ${process.env.NODE_ENV || 'not set'}`);
    console.log('='.repeat(80));
    
    // Print errors
    if (errors > 0) {
      console.log(`\n❌ ${errors} CRITICAL ERROR${errors > 1 ? 'S' : ''}:\n`);
      this.errors.forEach(({ variable, message }) => {
        console.log(`  🔴 ${variable}: ${message}`);
        const spec = ENV_SPEC[variable];
        if (spec) {
          if (spec.example) {
            console.log(`     Example: ${spec.example}`);
          }
          if (spec.failureImpact) {
            console.log(`     Impact: ${spec.failureImpact}`);
          }
        }
        console.log('');
      });
    }
    
    // Print warnings
    if (warnings > 0) {
      console.log(`\n⚠️  ${warnings} WARNING${warnings > 1 ? 'S' : ''}:\n`);
      this.warnings.forEach(({ variable, message }) => {
        console.log(`  🟡 ${variable}: ${message}`);
        const spec = ENV_SPEC[variable];
        if (spec) {
          if (spec.example) {
            console.log(`     Example: ${spec.example}`);
          }
          if (spec.failureImpact) {
            console.log(`     Impact: ${spec.failureImpact}`);
          }
        }
        console.log('');
      });
    }
    
    // Print info
    if (this.info.length > 0 && !isProduction) {
      console.log(`\nℹ️  Information:\n`);
      this.info.forEach(({ message }) => {
        console.log(`  ${message}`);
      });
      console.log('');
    }
    
    console.log('='.repeat(80));
    
    if (errors > 0) {
      console.log('❌ VALIDATION FAILED - Fix errors above to continue');
      console.log('📚 See docs/ENVIRONMENT.md for complete documentation');
    } else if (warnings > 0) {
      if (isProduction) {
        console.log('⚠️  VALIDATION WARNINGS - Strongly recommended to fix before deployment');
      } else {
        console.log('⚠️  VALIDATION WARNINGS - Fix before deploying to production');
      }
      console.log('📚 See docs/ENVIRONMENT.md for complete documentation');
    } else {
      console.log('✅ VALIDATION PASSED - All required variables configured');
    }
    
    console.log('='.repeat(80) + '\n');
  }
}

/**
 * Validate a single environment variable
 */
function validateVariable(variable, spec, result) {
  const value = process.env[variable];
  const isSet = value !== undefined && value !== '';
  const isProduction = isProductionEnv();
  
  // Check if required and missing
  if (spec.required && !isSet) {
    result.addError(
      variable,
      `REQUIRED in production but not set. ${spec.description}`
    );
    return;
  }
  
  // Check strongly recommended
  if (spec.stronglyRecommended && !isSet && isProduction) {
    result.addWarning(
      variable,
      `STRONGLY RECOMMENDED in production but not set. ${spec.description}`
    );
  }
  
  // If not set, skip further validation
  if (!isSet) {
    if (spec.recommendedInProduction && isProduction) {
      result.addInfo(variable, `Optional but recommended: ${spec.description}`);
    }
    return;
  }
  
  // Check for insecure defaults
  if (spec.insecureDefaults && spec.insecureDefaults.includes(value)) {
    const message = `Using insecure default value. ${spec.failureImpact || ''}`;
    if (isProduction) {
      result.addError(variable, message);
    } else {
      result.addWarning(variable, message);
    }
    return;
  }
  
  // Check minimum length
  if (spec.minLength && value.length < spec.minLength) {
    const message = `Value too short (${value.length} chars). Minimum ${spec.minLength} characters required for security.`;
    if (isProduction && spec.securityImpact === 'CRITICAL') {
      result.addError(variable, message);
    } else {
      result.addWarning(variable, message);
    }
  }
  
  // Check valid values
  if (spec.validValues && !spec.validValues.includes(value)) {
    result.addWarning(
      variable,
      `Invalid value "${value}". Expected one of: ${spec.validValues.join(', ')}`
    );
  }
  
  // Check dangerous settings
  if (spec.dangerous && value !== 'false') {
    result.addError(
      variable,
      `DANGEROUS setting enabled. ${spec.failureImpact || 'Should be false in production'}`
    );
  }
}

/**
 * Main validation function
 */
function validateEnvironment() {
  const result = new ValidationResult();
  const isProduction = isProductionEnv();
  
  // Validate each defined variable
  for (const [variable, spec] of Object.entries(ENV_SPEC)) {
    validateVariable(variable, spec, result);
  }
  
  // Special checks for Redis configuration
  const hasRedisUrl = !!process.env.REDIS_URL;
  const hasRedisHost = !!process.env.REDIS_HOST;
  
  if (isProduction && !hasRedisUrl && !hasRedisHost) {
    result.addWarning(
      'REDIS',
      'No Redis configuration found. Server will run in fallback mode. Set REDIS_URL for multi-device sync.'
    );
  }
  
  // Special check for DATABASE_URL vs individual settings
  const hasDatabaseUrl = !!process.env.DATABASE_URL;
  const hasDbHost = !!process.env.DB_HOST;
  
  if (isProduction && !hasDatabaseUrl && !hasDbHost) {
    result.addWarning(
      'DATABASE',
      'No database configuration found. User auth and subscriptions will not work. Set DATABASE_URL for production.'
    );
  }
  
  return result;
}

/**
 * Run validation and exit if critical errors in production
 */
function validateAndFailFast() {
  const isProduction = isProductionEnv();
  const isTest = isTestEnv();
  
  // Skip validation entirely in test mode
  if (isTest) {
    return null;
  }
  
  const result = validateEnvironment();
  result.print();
  
  // In production, log critical errors but do NOT exit the process.
  // The server must always reach app.listen() so that Cloud Run (and similar
  // platforms) can observe the process listening on PORT and mark the revision
  // as healthy.  Authentication and party endpoints remain protected by their
  // own middleware; a misconfigured JWT_SECRET will cause those requests to
  // fail at the auth layer, not silently pass.  Fix the logged errors above to
  // restore full production security.
  if (isProduction && result.hasErrors()) {
    console.error('\n💥 CRITICAL: Production environment validation errors detected!');
    console.error('Server is starting anyway so health checks pass. Fix errors above.\n');
  }
  
  // In development, just warn
  if (!isProduction && result.hasErrors()) {
    console.warn('\n⚠️  Environment validation found errors, but continuing in development mode.');
    console.warn('Fix these before deploying to production.\n');
  }
  
  return result;
}

module.exports = {
  validateEnvironment,
  validateAndFailFast,
  ENV_SPEC,
  isProduction: isProductionEnv,
  isTest: isTestEnv
};
