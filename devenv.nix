{ pkgs, lib, config, inputs, ... }:

{
  packages = [
    pkgs.git
    pkgs.nodejs_20
    ];
}
