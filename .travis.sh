# Exit on any error
set -e

rm -rf ./modpack
git clone $MODPACKREPO modpack

cd ./modpack 
git checkout $BRANCH 
git reset --hard $COMMITHASH 

cd ..

gulp