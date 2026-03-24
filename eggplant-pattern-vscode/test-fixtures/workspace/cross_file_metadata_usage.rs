fn cross_file_metadata_pat<PR: PatRecSgl>() -> CrossFileMetadataPat<PR> {
    let x = SharedMath::query_leaf();
    let one = SharedConst::query();
    let integ = SharedIntegral::query(&one, &x);
    let constraint = one.handle_n().eq(&1_i64);
    CrossFileMetadataPat::new(x, one, integ).assert(constraint)
}
