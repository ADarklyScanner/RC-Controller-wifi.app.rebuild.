plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val run = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "com.darkly.fpvcar"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.darkly.fpvcar"
        minSdk = 29
        targetSdk = 34
        versionCode = run
        versionName = "1.0.$run"
    }

    // One fixed key, so each new build installs over the last one instead of needing an uninstall.
    signingConfigs {
        create("shared") {
            storeFile = file("fpvcar.keystore")
            storePassword = "fpvcar-build"
            keyAlias = "fpvcar"
            keyPassword = "fpvcar-build"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("shared")
        }
        getByName("debug") {
            signingConfig = signingConfigs.getByName("shared")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
